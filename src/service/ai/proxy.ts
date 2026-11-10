import { Provide, Inject, Config } from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import fetch from 'node-fetch';
import { R } from '../../common/base.error.utils';
import { AiUsageLogEntity } from '../../entity/aiUsageLog';
import { AiCallLogEntity } from '../../entity/aiCallLog';
import { isMembershipFree, MembershipConfig } from '../../common/membership';
import { IrisGuardService, clampMessages, clampTask } from './irisGuard';
import {
  buildHintPrompt,
  buildReviewPrompt,
  buildGradeMessages,
  buildGenerateMessages,
  buildCoachTipMessages,
  buildWeeklyReportMessages,
  buildInterviewMessages,
  buildCompanyInterviewMessages,
  buildQuizReviewMessages,
  QuizReviewParams,
  HintParams,
  ReviewParams,
  GradeBuildParams,
  GenerateBuildParams,
  CoachTipParams,
  WeeklyReportParams,
  InterviewParams,
  CompanyInterviewParams,
} from './prompts';

export type AiTask =
  | ({ kind: 'hint' } & HintParams)
  | ({ kind: 'review' } & ReviewParams);

export type Verdict = '对' | '部分对' | '错';

export interface GradeResult {
  itemVerdicts: { index: number; verdict: Verdict }[];
  diagnosis: string;
  suggestions?: {
    reviewArticles: { title: string; articleKey: string }[];
    followUp: string;
    nextStep: string;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 上游 usage 归一化（DeepSeek 带缓存命中与思考 token，OpenAI/DashScope 只有总数）。 */
export interface AiUsage {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
}

export function readUsage(raw: unknown): AiUsage {
  const u = (raw || {}) as Record<string, any>;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  return {
    totalTokens: Number(u.total_tokens ?? 0) || prompt + completion,
    promptTokens: prompt,
    completionTokens: completion,
    cacheHitTokens: Number(u.prompt_cache_hit_tokens ?? 0) || 0,
    cacheMissTokens: Number(u.prompt_cache_miss_tokens ?? 0) || 0,
    reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
  };
}

/**
 * 把 SSE 字节流切成完整的 `data:` 行。上游一个 JSON 帧可能跨两个 TCP chunk，
 * 直接按 chunk split 会把半行当畸形 JSON 丢掉（内容悄悄缺字）。
 */
export class SseLineBuffer {
  private buf = '';
  push(text: string): string[] {
    this.buf += text;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() || '';
    return parts
      .map(l => l.trim())
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim());
  }
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest.startsWith('data:') ? [rest.slice(5).trim()] : [];
  }
}

export interface ChatContext {
  module: string;
  articleKey?: string;
  /** 服务端注入的站内召回资料（RAG），用于引用式回答 */
  ragContext?: string;
}

interface AiConfig {
  provider: string;
  apiKey: string;
  model: string;
  /** 面试复盘报告用的模型（更强、低频），缺省回退 model */
  reportModel?: string;
  rateLimit: {
    freeUserPerDay: number;
    freeWindowSeconds: number;
  };
}

export const IRIS_SOUL = `你是 Iris——希腊神话中的彩虹女神、众神与凡人之间的信使。在这个 Agent 工程师学习平台里,你是用户的研发向导,连接「他」与「知识」。
你的性格:沉稳、专业、克制,点到为止,像可信赖的登山向导——指路,但不替他走;在关键时刻给恰到好处的鼓励。
你的准则:
1. 授人以渔:默认引导而非代劳,能用一个好问题点醒就不直接给答案。
2. 苏格拉底式:用追问和关键观察推动他自己想明白。
3. 诚实克制:不确定就承认,不夸大、不吹捧、不编造 API 或数字。
4. 简洁:先给最关键的一句,再按需展开,信息密度高、废话少。
5. 第一人称、平等温暖的向导口吻。`;

const MODULE_PERSONA: Record<string, string> = {
  knowledge: '在前端技术(JavaScript/TypeScript/React/Vue/CSS)与职业发展、求职规划上你尤其在行。',
  interview: '你熟悉各大公司的面试套路与答题技巧。',
  algorithm: '在数据结构与算法上你尤其在行；面对题目你循序渐进地给提示，默认不直接给出完整答案。',
  fullstack: '在 Node.js、数据库、API 与服务部署上你尤其在行。',
  agent: '在 LLM 应用、Prompt、RAG、Agent 框架(LangChain/Vercel AI SDK/MCP)与生产级 AI 系统上你尤其在行。',
};

const DEFAULT_PERSONA = '你帮助用户学习前端、全栈与 AI Agent 工程。';

export function buildModulePersona(module: string): string {
  const expertise = MODULE_PERSONA[module] || DEFAULT_PERSONA;
  return `${IRIS_SOUL}\n\n${expertise}`;
}

@Provide()
export class AiProxyService {
  @Config('ai')
  aiConfig: AiConfig;

  // 限时免费开关：开启时全站不限流（与各 caller 传入的 isMember 无关，作为兜底闸门，
  // 避免任一路径误判非会员就限流）。
  @Config('membership')
  membershipConfig: MembershipConfig;

  @Inject()
  redisService: RedisService;

  @Inject()
  irisGuard: IrisGuardService;

  @InjectEntityModel(AiUsageLogEntity)
  aiUsageLogModel: Repository<AiUsageLogEntity>;

  @InjectEntityModel(AiCallLogEntity)
  aiCallLogModel: Repository<AiCallLogEntity>;

  private async logCall(p: {
    userId: string;
    route: string;
    inputSummary: string;
    latencyMs: number;
    tokenUsed: number;
    status: string;
    errorMsg?: string;
    // agentic 可观测扩展（仅 agentic 链路传）
    module?: string;
    mode?: string;
    rounds?: number;
    toolCallCount?: number;
    fallbackFlags?: any;
    costEstimate?: number;
    retrievedRefs?: any;
  }): Promise<void> {
    try {
      await this.aiCallLogModel.save(
        this.aiCallLogModel.create({
          userId: p.userId,
          route: p.route,
          module: p.module ?? null,
          inputSummary: (p.inputSummary || '').slice(0, 500),
          latencyMs: p.latencyMs,
          tokenUsed: p.tokenUsed,
          status: p.status,
          errorMsg: p.errorMsg ? String(p.errorMsg).slice(0, 500) : null,
          mode: p.mode ?? null,
          rounds: p.rounds ?? null,
          toolCallCount: p.toolCallCount ?? null,
          fallbackFlags: p.fallbackFlags ?? null,
          costEstimate: p.costEstimate ?? null,
          retrievedRefs: p.retrievedRefs ?? null,
        })
      );
    } catch {
      /* 记录失败不影响主流程 */
    }
  }

  /**
   * 免费用户的每日调用闸。
   *
   * @param bucket 配额桶。缺省＝用户自己提的问题；传 'aux' 走独立桶——
   *   「猜你想问」这类由界面自动发起的辅助调用**不是用户的提问**，不该占用户的额度
   *   （2026-09-20 复盘：访客开几篇文章，配额就被我们自己的自动调用吃掉了），
   *   但它照样烧钱，所以给同等上限而不是放行。
   */
  async checkRateLimit(userId: string, isMember: boolean, bucket?: 'aux'): Promise<void> {
    if (isMembershipFree(this.membershipConfig)) return; // 限免期：全员不限流
    if (isMember) return; // members have no limit
    // 游客的辅助调用（猜你想问）同样计入全站游客兜底
    if (this.irisGuard) await this.irisGuard.guestPrecheck(userId);
    const limit = this.aiConfig.rateLimit.freeUserPerDay;
    const key = bucket ? `ai:rate:day:${bucket}:${userId}` : `ai:rate:day:${userId}`;
    const current = await this.redisService.incr(key);
    if (current === 1) {
      await this.redisService.expire(key, this.aiConfig.rateLimit.freeWindowSeconds);
    }
    if (current > limit) {
      // 文案须与前端 Composer 的额度用尽横幅一致（本文案在非流式路径与其他客户端可见）。
      // 2026-10-02 起注册不再赠送试用、会员暂停售卖（user.createUser / loginModal /
      // Composer 已同步改掉），所以这里**既不能许诺「注册送 14 天」，也不能引导
      // 「开通会员」**——前者已不兑现，后者已买不到。与前端同口径：游客登录可保存
      // 学习记录，额度次日重置。
      const next = String(userId).startsWith('guest:')
        ? '登录后可保存学习记录，明天再来'
        : '明天再来';
      throw R.forbiddenError(`RATE_LIMIT:今日 AI 问答次数已用完（每天 ${limit} 次），${next}`);
    }
  }

  async getQuota(userId: string, isMember: boolean): Promise<{ used: number; limit: number | null; resetAt: string | null }> {
    if (isMembershipFree(this.membershipConfig) || isMember) {
      return { used: 0, limit: null, resetAt: null };
    }
    const key = `ai:rate:day:${userId}`;
    const usedStr = await this.redisService.get(key);
    const used = parseInt(usedStr || '0', 10);
    const ttl = await this.redisService.ttl(key);
    const resetAt = ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null;
    return { used, limit: this.aiConfig.rateLimit.freeUserPerDay, resetAt };
  }

  buildSystemPrompt(context: ChatContext): string {
    let base = `${buildModulePersona(context.module)}\n\n请用中文回答，代码示例用 Markdown。`;
    if (context.ragContext) {
      base += `\n\n以下是从站内知识库检索到的相关资料，请优先基于这些资料作答，并在末尾用「延伸阅读」列出引用到的文章标题；若资料不足以回答则如实说明、不要编造：\n${context.ragContext}`;
    }
    return base;
  }

  /** 通用非流式补全：给定 system + user，返回正文。用于提示/点评/判分。 */
  private async complete(
    systemPrompt: string,
    userPrompt: string,
    userId: string,
    module: string,
    maxTokens = 2048
  ): Promise<string> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');
    const started = Date.now();
    const { url, headers } = this.getRequestConfig(false);
    const body = this.buildRequestBody(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      false
    ) as Record<string, unknown>;
    if (typeof body.max_tokens === 'number') body.max_tokens = maxTokens;
    // DashScope 形态：max_tokens 在 parameters 下
    if (body.parameters && typeof body.parameters === 'object') {
      (body.parameters as Record<string, unknown>).max_tokens = maxTokens;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw R.error(`AI 服务请求失败 (${response.status})${text ? ': ' + text : ''}`);
      }
      const result = (await response.json()) as Record<string, unknown>;
      const usage = result?.usage as { total_tokens?: number };
      const tokenUsed = usage?.total_tokens || 0;
      await this.logUsage(userId, module, tokenUsed);
      await this.logCall({
        userId,
        route: module,
        inputSummary: userPrompt,
        latencyMs: Date.now() - started,
        tokenUsed,
        status: 'success',
        mode: this.aiConfig.model,
      });
      return this.extractContent(result);
    } catch (err: any) {
      await this.logCall({
        userId,
        route: module,
        inputSummary: userPrompt,
        latencyMs: Date.now() - started,
        tokenUsed: 0,
        status: 'error',
        errorMsg: err?.message,
      });
      throw err;
    }
  }

  /** 主动教练：进入文章时的个性化一句提示（PRD-02 F2-2）。失败返回空串。 */
  async coachTip(p: CoachTipParams, userId: string): Promise<string> {
    try {
      const { system, user } = buildCoachTipMessages(p);
      const text = await this.complete(system, user, userId, 'coach', 256);
      return (text || '').trim();
    } catch {
      return '';
    }
  }

  /** 主动教练：学习周报文案（PRD-02 F2-2）。失败返回空串。 */
  async weeklyReport(p: WeeklyReportParams, userId: string): Promise<string> {
    try {
      const { system, user } = buildWeeklyReportMessages(p);
      const text = await this.complete(system, user, userId, 'coach', 512);
      return (text || '').trim();
    } catch {
      return '';
    }
  }

  /** 给离线评测用的原始补全（复用统一调用与计量）。 */
  async completeRaw(system: string, user: string, userId = 'eval-bot'): Promise<string> {
    return this.complete(system, user, userId, 'eval', 1024);
  }

  /** AI 审 AI：复核自动生成的题目（PRD-08）。返回 {verdict, confidence, issues}。 */
  async reviewQuiz(
    p: QuizReviewParams,
    userId: string
  ): Promise<{ verdict: 'pass' | 'fail'; confidence: number; issues: string[] }> {
    const fallback = { verdict: 'fail' as const, confidence: 0, issues: ['复核失败'] };
    try {
      const { system, user } = buildQuizReviewMessages(p);
      const raw = await this.complete(system, user, userId, 'ops-review', 1024);
      const parsed = this.parseJsonLoose<any>(raw);
      if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'fail')) return fallback;
      return {
        verdict: parsed.verdict,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      };
    } catch {
      return fallback;
    }
  }

  /** AI 模拟面试（PRD-05 P2）：返回面试官的下一句（点评+追问/出题）。 */
  async interview(p: InterviewParams, userId: string): Promise<string> {
    const { system, user } = buildInterviewMessages(p);
    return this.complete(system, user, userId, 'interview', 1024);
  }

  /** 按目标公司 / 岗位模拟面试：题目来自那批真实面经；整体点评较长，放宽输出长度。 */
  async companyInterview(p: CompanyInterviewParams, userId: string): Promise<string> {
    const { system, user } = buildCompanyInterviewMessages(p);
    return this.complete(system, user, userId, 'interview', p.finish ? 1600 : 1024);
  }

  /** 算法分层提示（服务端拼装提示词，不剧透）。 */
  async hint(p: HintParams, userId: string): Promise<string> {
    const { system, user } = buildHintPrompt(p);
    return this.complete(system, user, userId, 'algorithm', 1024);
  }

  /** 代码点评（服务端拼装约束）。 */
  async review(p: ReviewParams, userId: string): Promise<string> {
    const { system, user } = buildReviewPrompt(p);
    return this.complete(system, user, userId, 'algorithm', 1536);
  }

  /**
   * 基于文章自动出题（PRD-02 F2-1）。返回题目草稿数组；解析失败返回空数组。
   */
  async generateQuestions(
    p: GenerateBuildParams,
    userId: string
  ): Promise<
    {
      type: string;
      stem: string;
      options?: { key: string; text: string }[];
      answer?: string[];
      analysis?: string;
      difficulty?: number;
      tags?: string[];
    }[]
  > {
    try {
      const { system, user } = buildGenerateMessages(p);
      const raw = await this.complete(system, user, userId, 'quiz', 2048);
      const arr = this.parseJsonArrayLoose<any>(raw);
      if (!Array.isArray(arr)) return [];
      const allowed = new Set(['single', 'multi', 'blank', 'qa']);
      return arr
        .filter((q) => q && allowed.has(q.type) && q.stem)
        .slice(0, p.count)
        .map((q) => ({
          type: q.type,
          stem: String(q.stem),
          options: Array.isArray(q.options) ? q.options : undefined,
          answer: Array.isArray(q.answer) ? q.answer.map(String) : [],
          analysis: q.analysis ? String(q.analysis) : '',
          difficulty: [1, 2, 3].includes(q.difficulty) ? q.difficulty : 1,
          tags: Array.isArray(q.tags) ? q.tags.map(String) : [],
        }));
    } catch {
      return [];
    }
  }

  /** 从输出里抽出第一个 JSON 数组。 */
  private parseJsonArrayLoose<T>(text: string): T[] | null {
    if (!text) return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T[];
    } catch {
      return null;
    }
  }

  /** 从可能含 ```json 包裹或多余文字的输出里抽出第一个 JSON 对象。 */
  private parseJsonLoose<T>(text: string): T | null {
    if (!text) return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }

  /**
   * 简答判分 + 定制化建议（PRD-01 F1-4 / PRD-02 F1-5）。整次汇总一次调用。
   * 失败时回退为空诊断，由上层决定降级展示，不抛错阻断闭环。
   */
  async gradeSubmission(p: GradeBuildParams, userId: string): Promise<GradeResult> {
    const fallback: GradeResult = {
      itemVerdicts: p.items.map((_, i) => ({ index: i, verdict: '部分对' as Verdict })),
      diagnosis: '',
    };
    try {
      const { system, user } = buildGradeMessages(p);
      const raw = await this.complete(system, user, userId, 'quiz', 1536);
      const parsed = this.parseJsonLoose<GradeResult>(raw);
      if (!parsed) return fallback;

      // 接地校验：reviewArticles 只允许出现在候选里，过滤幻觉
      if (parsed.suggestions && p.member) {
        const allow = new Map((p.candidates || []).map((c) => [c.articleKey, c.title]));
        const filtered = (parsed.suggestions.reviewArticles || []).filter((a) =>
          allow.has(a.articleKey)
        );
        parsed.suggestions.reviewArticles = filtered.map((a) => ({
          articleKey: a.articleKey,
          title: allow.get(a.articleKey) || a.title,
        }));
      } else {
        delete parsed.suggestions; // 非会员不返回深度建议
      }
      if (!Array.isArray(parsed.itemVerdicts)) parsed.itemVerdicts = fallback.itemVerdicts;
      return parsed;
    } catch {
      return fallback;
    }
  }

  /** DeepSeek 与 OpenAI 使用相同的 chat/completions 协议格式。 */
  private isOpenAiStyle(): boolean {
    return (
      this.aiConfig.provider === 'openai' ||
      this.aiConfig.provider === 'deepseek'
    );
  }

  private buildRequestBody(
    messages: ChatMessage[],
    systemPrompt: string,
    streaming: boolean,
    deepThink = false
  ) {
    const allMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    if (this.isOpenAiStyle()) {
      // 深度思考：DeepSeek V4 起，思考模式改为「请求体参数」而非独立模型名。
      // 旧的 deepseek-reasoner 模型名于 2026-07-24 弃用——统一用 aiConfig.model
      //（deepseek-flash＝V4.1 Flash）+ thinking 参数触发思考；reasoning_content 仍在
      // delta.reasoning_content 流式返回（extractStreamContent 已读取）。
      const body: Record<string, unknown> = {
        model: this.aiConfig.model,
        messages: allMessages,
        stream: streaming,
        max_tokens: 2048,
        ...this.thinkingParams(deepThink),
      };
      // 流式也要拿到 usage：最后一帧（finish_reason 之后、[DONE] 之前）单独带 usage
      if (streaming) body.stream_options = { include_usage: true };
      return body;
    }

    // Default: DashScope (通义千问)
    const params: Record<string, unknown> = { result_format: 'message' };
    if (streaming) params.incremental_output = true;

    return {
      model: this.aiConfig.model,
      input: { messages: allMessages },
      parameters: params,
    };
  }

  /**
   * 思考开关的请求体参数。
   * ⚠️ DeepSeek 官方文档：`thinking` 与 `reasoning_effort` **都省略时默认开启思考**。
   * 2026-11-02 前这里只在 deepThink 时传 enabled、不传时什么都不传——于是前端关掉「深度思考」
   * 后模型照样思考（延迟高、输出 token 贵 4 倍），只是我们不把 reasoning_content 透出来。
   * 非思考必须显式 disabled；openai 供应商不认这些字段，一律不传。
   */
  private thinkingParams(deepThink: boolean): Record<string, unknown> {
    if (this.aiConfig.provider !== 'deepseek') return {};
    if (!deepThink) return { thinking: { type: 'disabled' } };
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: process.env.LLM_REASONING_EFFORT || 'high',
    };
  }

  /**
   * 通用非流式补全（可指定模型 / JSON 输出 / 长度），给低频长输出任务（面试复盘报告）用。
   * 仅 OpenAI 兼容协议；DashScope 形态下忽略 model/json 选项走默认链路。
   */
  async completeWith(
    systemPrompt: string,
    userPrompt: string,
    opts: { userId: string; module: string; model?: string; json?: boolean; maxTokens?: number; deepThink?: boolean }
  ): Promise<{ content: string; usage: AiUsage }> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');
    const started = Date.now();
    const { url, headers } = this.getRequestConfig(false);
    const body = this.buildRequestBody(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      false,
      !!opts.deepThink
    ) as Record<string, unknown>;
    const maxTokens = opts.maxTokens || 4096;
    if (this.isOpenAiStyle()) {
      if (opts.model) body.model = opts.model;
      body.max_tokens = maxTokens;
      if (opts.json) body.response_format = { type: 'json_object' };
    } else if (body.parameters && typeof body.parameters === 'object') {
      (body.parameters as Record<string, unknown>).max_tokens = maxTokens;
    }
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw R.error(`AI 服务请求失败 (${response.status})${text ? ': ' + text : ''}`);
      }
      const result = (await response.json()) as Record<string, unknown>;
      const usage = readUsage(result?.usage);
      await this.logUsage(opts.userId, opts.module, usage.totalTokens);
      await this.logCall({
        userId: opts.userId,
        route: opts.module,
        inputSummary: userPrompt,
        latencyMs: Date.now() - started,
        tokenUsed: usage.totalTokens,
        status: 'success',
        mode: String(body.model || this.aiConfig.model),
      });
      return { content: this.extractContent(result), usage };
    } catch (err: any) {
      await this.logCall({
        userId: opts.userId,
        route: opts.module,
        inputSummary: userPrompt,
        latencyMs: Date.now() - started,
        tokenUsed: 0,
        status: 'error',
        errorMsg: err?.message,
        mode: String(body.model || this.aiConfig.model),
      });
      throw err;
    }
  }

  /** 主模型名（问答 / 思考 / 模拟面试共用；真源 config/llmModel.ts） */
  chatModel(): string {
    return this.aiConfig.model;
  }

  /** 报告模型名（配置可覆盖，缺省回退主模型） */
  reportModel(): string {
    return this.aiConfig.reportModel || this.aiConfig.model;
  }

  private getRequestConfig(streaming: boolean): { url: string; headers: Record<string, string> } {
    if (this.isOpenAiStyle()) {
      return {
        url:
          this.aiConfig.provider === 'deepseek'
            ? 'https://api.deepseek.com/chat/completions'
            : 'https://api.openai.com/v1/chat/completions',
        headers: {
          'Authorization': `Bearer ${this.aiConfig.apiKey}`,
          'Content-Type': 'application/json',
          ...(streaming ? { 'Accept': 'text/event-stream' } : {}),
        },
      };
    }

    // Default: DashScope
    return {
      url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      headers: {
        'Authorization': `Bearer ${this.aiConfig.apiKey}`,
        'Content-Type': 'application/json',
        ...(streaming ? { 'Accept': 'text/event-stream' } : {}),
      },
    };
  }

  private extractContent(data: Record<string, unknown>): string {
    if (this.isOpenAiStyle()) {
      const choices = data?.choices as Array<{ message?: { content?: string }; delta?: { content?: string } }>;
      return choices?.[0]?.message?.content || choices?.[0]?.delta?.content || '';
    }
    // DashScope
    const output = data?.output as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    return output?.choices?.[0]?.message?.content || '';
  }

  private extractStreamContent(data: Record<string, unknown>): {
    content: string;
    reasoning: string;
    done: boolean;
  } {
    if (this.isOpenAiStyle()) {
      const choices = data?.choices as Array<{
        delta?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
      return {
        content: choices?.[0]?.delta?.content || '',
        // 深度思考的链路：reasoner 在正文前先流式吐 reasoning_content
        reasoning: choices?.[0]?.delta?.reasoning_content || '',
        done: choices?.[0]?.finish_reason === 'stop',
      };
    }
    // DashScope（无思考链）
    const output = data?.output as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    return {
      content: output?.choices?.[0]?.message?.content || '',
      reasoning: '',
      done: output?.choices?.[0]?.finish_reason === 'stop',
    };
  }

  private async logUsage(userId: string, module: string, tokenUsed: number): Promise<void> {
    try {
      const log = new AiUsageLogEntity();
      log.userId = userId;
      log.module = module;
      log.tokenUsed = tokenUsed;
      log.provider = this.aiConfig.provider;
      await this.aiUsageLogModel.save(log);
    } catch {
      // Non-critical: don't fail the request if logging fails
    }
    // 成本闸记账 + 异常告警（见 irisGuard.ts）；失败不影响请求
    try {
      if (this.irisGuard) await this.irisGuard.record(userId, module, tokenUsed);
    } catch {
      /* ignore */
    }
  }

  async forward(messages: ChatMessage[], context: ChatContext, userId: string): Promise<string> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');

    const systemPrompt = this.buildSystemPrompt(context);
    const { url, headers } = this.getRequestConfig(false);
    const body = this.buildRequestBody(clampMessages(messages), systemPrompt, false);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw R.error(`AI 服务请求失败 (${response.status})${text ? ': ' + text : ''}`);
    }

    const result = await response.json() as Record<string, unknown>;
    const content = this.extractContent(result);

    const usage = result?.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number };
    const tokenUsed = usage?.total_tokens || (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
    await this.logUsage(userId, context.module, tokenUsed);

    return content;
  }

  /**
   * 流式核心：给定已拼好的 systemPrompt + messages，向上游真流式拉取并逐帧产出
   * { content?, reasoning? }。被 forwardStream / forwardTaskStream 复用，
   * 统一身份/计量/思考链透传。
   */
  async *streamCore(
    systemPrompt: string,
    messages: ChatMessage[],
    module: string,
    userId: string,
    deepThink = false
  ): AsyncGenerator<{ content?: string; reasoning?: string }> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');

    const { url, headers } = this.getRequestConfig(true);
    const body = this.buildRequestBody(messages, systemPrompt, true, deepThink);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw R.error(`AI 服务请求失败 (${response.status})${text ? ': ' + text : ''}`);
    }

    if (!response.body) throw R.error('AI 服务响应异常');

    let usage: AiUsage | null = null;
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    const lines = new SseLineBuffer();

    // 不在 finish_reason 处提前返回：开了 stream_options.include_usage 后 usage 在其后一帧单独下发，
    // 提前返回就永远记不到用量（2026-11-02 前流式用量一直记 0 就是这个原因）。
    outer: for await (const chunk of response.body) {
      for (const rawData of lines.push(decoder.write(chunk as Buffer))) {
        if (rawData === '[DONE]') break outer;
        try {
          const parsed = JSON.parse(rawData) as Record<string, unknown>;
          const { content, reasoning } = this.extractStreamContent(parsed);
          // 思考链先于正文：分别下发，前端据此渲染「深度思考」块与正文
          if (reasoning) yield { reasoning };
          if (content) yield { content };
          if (parsed?.usage) usage = readUsage(parsed.usage);
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    await this.logUsage(userId, module, usage?.totalTokens || 0);
  }

  async *forwardStream(
    messages: ChatMessage[],
    context: ChatContext,
    userId: string,
    deepThink = false
  ): AsyncGenerator<{ content?: string; reasoning?: string }> {
    const systemPrompt = this.buildSystemPrompt(context || ({} as ChatContext));
    // 客户端传来的历史一律裁剪（irisGuard.clampMessages）：11-03 单次 50 万 token 就是超长历史
    yield* this.streamCore(systemPrompt, clampMessages(messages), context?.module, userId, deepThink);
  }

  /**
   * 结构化任务流式（PRD-02 F1-3）：算法分层提示 / 代码点评。
   * 提示词与「不剧透」约束在服务端拼装，前端只传结构化参数，无法绕过。
   * hint 不走深度思考（短、快）；review 可深度思考。
   */
  async *forwardTaskStream(
    task: AiTask,
    userId: string,
    deepThink = false
  ): AsyncGenerator<{ content?: string; reasoning?: string }> {
    let system: string;
    let user: string;
    task = clampTask(task);
    if (task.kind === 'hint') {
      ({ system, user } = buildHintPrompt(task));
      deepThink = false;
    } else {
      ({ system, user } = buildReviewPrompt(task));
    }
    yield* this.streamCore(
      system,
      [{ role: 'user', content: user }],
      'algorithm',
      userId,
      deepThink
    );
  }

  /** agentic loop 仅支持 OpenAI 兼容协议（deepseek/openai）；DashScope 形态不支持 tools。 */
  supportsTools(): boolean {
    return this.isOpenAiStyle();
  }

  /**
   * 无工具、非思考的流式回答：教练循环的降级链用它兜底。
   */
  async *streamFinal(
    systemPrompt: string,
    rawMessages: any[],
    module: string,
    userId: string
  ): AsyncGenerator<{ content?: string }> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');
    const { url, headers } = this.getRequestConfig(true);
    const body: Record<string, unknown> = {
      model: this.aiConfig.model,
      messages: [{ role: 'system', content: systemPrompt }, ...rawMessages],
      stream: true,
      max_tokens: 2048,
      stream_options: { include_usage: true },
      ...this.thinkingParams(false),
    };
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw R.error(`AI 服务请求失败 (${response.status})${text ? ': ' + text : ''}`);
    }
    if (!response.body) throw R.error('AI 服务响应异常');

    let totalTokens = 0;
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    const lines = new SseLineBuffer();
    outer: for await (const chunk of response.body) {
      for (const rawData of lines.push(decoder.write(chunk as Buffer))) {
        if (rawData === '[DONE]') break outer;
        try {
          const parsed = JSON.parse(rawData) as Record<string, unknown>;
          const { content } = this.extractStreamContent(parsed);
          if (content) yield { content };
          if (parsed?.usage) totalTokens = readUsage(parsed.usage).totalTokens;
        } catch {
          /* 跳过畸形 SSE 行 */
        }
      }
    }
    await this.logUsage(userId, module, totalTokens);
  }

  /** 新引擎（aisdkLoop）落用量 + 成本闸记账，口径同 logUsage。 */
  async recordUsage(userId: string, module: string, tokenUsed: number): Promise<void> {
    await this.logUsage(userId, module, tokenUsed);
  }

  /** 供 agentic loop 落 aiCallLog（复用私有 logCall）。 */
  async logAgenticCall(p: {
    userId: string;
    module: string;
    mode: string;
    inputSummary: string;
    latencyMs: number;
    tokenUsed: number;
    rounds: number;
    toolCallCount: number;
    fallbackFlags: any;
    costEstimate: number;
    retrievedRefs: any;
    status: string;
    errorMsg?: string;
  }): Promise<void> {
    await this.logCall({
      userId: p.userId,
      route: 'agentic',
      module: p.module,
      mode: p.mode,
      inputSummary: p.inputSummary,
      latencyMs: p.latencyMs,
      tokenUsed: p.tokenUsed,
      rounds: p.rounds,
      toolCallCount: p.toolCallCount,
      fallbackFlags: p.fallbackFlags,
      costEstimate: p.costEstimate,
      retrievedRefs: p.retrievedRefs,
      status: p.status,
      errorMsg: p.errorMsg,
    });
  }
}
