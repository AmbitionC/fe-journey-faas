import { Provide, Inject, Config } from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import fetch from 'node-fetch';
import { R } from '../../common/base.error.utils';
import { AiUsageLogEntity } from '../../entity/aiUsageLog';
import {
  buildHintPrompt,
  buildReviewPrompt,
  buildGradeMessages,
  buildGenerateMessages,
  buildCoachTipMessages,
  buildWeeklyReportMessages,
  HintParams,
  ReviewParams,
  GradeBuildParams,
  GenerateBuildParams,
  CoachTipParams,
  WeeklyReportParams,
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
  knowledge: '在前端技术(JavaScript/TypeScript/React/Vue/CSS)上你尤其在行。',
  firstclass: '在职业发展与学习路径规划上你尤其在行。',
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

  @Inject()
  redisService: RedisService;

  @InjectEntityModel(AiUsageLogEntity)
  aiUsageLogModel: Repository<AiUsageLogEntity>;

  async checkRateLimit(userId: string, isMember: boolean): Promise<void> {
    if (isMember) return; // members have no limit
    const limit = this.aiConfig.rateLimit.freeUserPerDay;
    const key = `ai:rate:day:${userId}`;
    const current = await this.redisService.incr(key);
    if (current === 1) {
      await this.redisService.expire(key, this.aiConfig.rateLimit.freeWindowSeconds);
    }
    if (current > limit) {
      throw R.forbiddenError(`RATE_LIMIT:今日 AI 问答次数已用完（每天 ${limit} 次），开通会员享无限使用`);
    }
  }

  async getQuota(userId: string, isMember: boolean): Promise<{ used: number; limit: number | null; resetAt: string | null }> {
    if (isMember) {
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
    const { url, headers } = this.getRequestConfig(false);
    const body = this.buildRequestBody(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      false
    ) as Record<string, unknown>;
    if (typeof body.max_tokens === 'number') body.max_tokens = maxTokens;

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
    await this.logUsage(userId, module, usage?.total_tokens || 0);
    return this.extractContent(result);
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
      // 深度思考：DeepSeek 走 reasoner 模型（流式 delta 里带 reasoning_content）。
      // 模型名可用 LLM_REASONER_MODEL 覆盖（默认 deepseek-reasoner）。
      const useReasoner = deepThink && this.aiConfig.provider === 'deepseek';
      return {
        model: useReasoner
          ? process.env.LLM_REASONER_MODEL || 'deepseek-reasoner'
          : this.aiConfig.model,
        messages: allMessages,
        stream: streaming,
        max_tokens: 2048,
      };
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
  }

  async forward(messages: ChatMessage[], context: ChatContext, userId: string): Promise<string> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');

    const systemPrompt = this.buildSystemPrompt(context);
    const { url, headers } = this.getRequestConfig(false);
    const body = this.buildRequestBody(messages, systemPrompt, false);

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
   * { content?, reasoning? }。被 forwardStream / forwardTaskStream / Copilot 适配器复用，
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

    let totalTokens = 0;
    const decoder = new (require('string_decoder').StringDecoder)('utf8');

    for await (const chunk of response.body) {
      const text = decoder.write(chunk as Buffer);
      const lines = text.split('\n').filter((l: string) => l.startsWith('data:'));

      for (const line of lines) {
        const rawData = line.slice(5).trim();
        if (rawData === '[DONE]') return;

        try {
          const parsed = JSON.parse(rawData) as Record<string, unknown>;
          const { content, reasoning, done } = this.extractStreamContent(parsed);

          // 思考链先于正文：分别下发，前端据此渲染「深度思考」块与正文
          if (reasoning) {
            yield { reasoning };
          }
          if (content) {
            yield { content };
          }

          // Track token usage from final SSE message
          const usage = parsed?.usage as { total_tokens?: number };
          if (usage?.total_tokens) totalTokens = usage.total_tokens;

          if (done) {
            await this.logUsage(userId, module, totalTokens);
            return;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    await this.logUsage(userId, module, totalTokens);
  }

  async *forwardStream(
    messages: ChatMessage[],
    context: ChatContext,
    userId: string,
    deepThink = false
  ): AsyncGenerator<{ content?: string; reasoning?: string }> {
    const systemPrompt = this.buildSystemPrompt(context);
    yield* this.streamCore(systemPrompt, messages, context.module, userId, deepThink);
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
}
