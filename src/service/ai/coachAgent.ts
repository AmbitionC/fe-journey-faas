import { Provide, Inject } from '@midwayjs/core';
import { AiProxyService, ChatMessage, buildModulePersona } from './proxy';
import { CoachToolsService, ToolContext, Citation } from './coachTools';
import { RetrieveService } from './retrieve';
import { ArticleContentService } from '../content/articleContent';
import { sanitizeForPrompt } from './sanitize';
import { runAiSdkLoop } from './aisdkLoop';

/** agentic loop 向外产出的 SSE 事件帧。 */
export interface AgenticFrame {
  status?: string;
  content?: string;
  citations?: Citation[];
  /** 结构化提问（选项气泡）：ask_question 工具触发，本轮以此结束等待用户作答 */
  question?: { question: string; options?: string[]; allowFreeText?: boolean };
  error?: string;
}

/** 模式定义（PRD-04 模式注册制）：系统指令 + 工具白名单 + 轮数。 */
interface ModeDef {
  tools: string[];
  rounds: number;
  instructions: string;
}

/** agentic 指令 + 教练边界（PRD-04 F7）：拼在模块画像之后作为系统提示词。 */
const AGENTIC_INSTRUCTIONS = `\n\n你能调用工具检索站内知识库来支撑回答。工作方式：
1. 回答站内知识问题前，优先用 search_articles 找依据；需要原文细节再 read_article；想做跨文章推荐用 get_catalog；要个性化就先 get_learner_state。
2. 回答必须基于站内资料，末尾用「延伸阅读」列出引用到的文章标题；站内确实没有就如实说明、绝不编造 API 或数字。
3. 用中文，代码用 Markdown。先给最关键的一句，再按需展开。`;

const COACH_BOUNDARY = `\n\n（重要边界）你是考官与学习向导，不是代码助手：不要输出成品代码、不替用户调试报错、不给可以直接粘贴运行的完整实现——这些用户自己的 IDE AI（Cursor / Claude Code）做得又快又好。你专注做它们做不到的事：对照站内知识判断用户的方向/方案对不对、指出他还缺哪块知识（并给出站内文章）、教他怎么把需求向 AI 说清楚。`;

// ---- 各模式指令（PRD-04 模式注册制） ----
const PLACEMENT_INSTR = `\n\n你在做「入门摸底」：围绕 Agent 工程师六段主干（LLM基础→Prompt/结构化/FC→RAG→Agent编排→Eval→生产化），通过 ask_question 一次问一个结构化选择题，判断用户的起点段（1-3）。已能从 get_learner_state 看出掌握的主题不要再问。问够 2-3 题后，给出一句起点判定结论（不再调用 ask_question，直接文字回答，形如"建议你从第 3 段 RAG 起步"）。`;

const ARTICLE_CHECK_INSTR = `\n\n你在做「文章测一测」：针对用户刚读的这篇文章，用 ask_question 出 1-2 个检验理解的结构化问题（选项气泡）。用户答完后，简短点评对错、点出易混淆处并给出原文依据；不要一上来就给答案。`;

const FEYNMAN_INSTR = `\n\n你在做「带你复习·讲给教练听」：让用户用自己的话讲这篇的关键点。用 ask_question 抛出引导问题，根据用户讲述追问薄弱环节（费曼式）。发现讲不清的点，指出并给原文段落，不代讲。`;

const PLAN_REVIEW_INSTR = `\n\n你在做「指挥方案审稿」：对照题目验收标准审用户的指挥方案，只提问不代做——挑出方案里没想清楚的漏洞（用 ask_question 或直接追问），引用站内文章补前置知识，最后给结论：通过 / 需修改。绝不代写方案或给成品 prompt。`;

const RESCUE_INSTR = `\n\n你在做「卡点急救」：报错和代码问题让用户自己的 IDE AI 修（更快更强），你只做三件事——①对照题目验收标准判断当前做法/方案能不能过；②指出缺哪块知识并给站内文章；③教用户怎么把需求向 AI 说清楚。绝不代写代码、不代调试。`;

const MODES: Record<string, ModeDef> = {
  qa: { tools: ['search_articles', 'read_article', 'get_catalog', 'get_learner_state'], rounds: 4, instructions: AGENTIC_INSTRUCTIONS },
  placement: { tools: ['get_catalog', 'get_learner_state', 'ask_question'], rounds: 3, instructions: PLACEMENT_INSTR },
  article_check: { tools: ['read_article', 'ask_question'], rounds: 3, instructions: ARTICLE_CHECK_INSTR },
  feynman: { tools: ['read_article', 'get_learner_state', 'ask_question'], rounds: 3, instructions: FEYNMAN_INSTR },
  plan_review: { tools: ['search_articles', 'read_article', 'ask_question'], rounds: 3, instructions: PLAN_REVIEW_INSTR },
  rescue: { tools: ['search_articles', 'read_article', 'get_learner_state'], rounds: 4, instructions: RESCUE_INSTR },
};

function resolveMode(mode?: string): { key: string; def: ModeDef } {
  const key = mode && MODES[mode] ? mode : 'qa';
  return { key, def: MODES[key] };
}

function buildAgenticSystemPrompt(module: string, instructions: string): string {
  return `${buildModulePersona(module)}${instructions}${COACH_BOUNDARY}`;
}

/** status 帧文案：把工具调用翻译成用户看得懂的「正在做什么」。 */
export function statusLabel(name: string, args: any): string {
  switch (name) {
    case 'search_articles':
      return `正在检索「${String(args?.query || '').slice(0, 30)}」…`;
    case 'read_article':
      return `正在查阅《${String(args?.key || '').slice(0, 40)}》…`;
    case 'get_catalog':
      return '正在浏览站内目录…';
    case 'get_learner_state':
      return '正在读取你的学习记录…';
    default:
      return '正在思考…';
  }
}

/**
 * 教练 agentic loop（PRD-04 F4 / 检索设计 §3）。
 * 一套工具驱动的多轮循环：模型自主决定查什么，服务端执行工具、推 status 帧，
 * 最终流式产出带引用的答案。与模型的多轮交互由 Vercel AI SDK 驱动（./aisdkLoop，工具轮开思考），
 * 自带兜底五件套 + 降级链，上游故障不白屏。
 */
@Provide()
export class CoachAgentService {
  @Inject()
  proxy: AiProxyService;

  @Inject()
  tools: CoachToolsService;

  @Inject()
  retrieveService: RetrieveService;

  @Inject()
  articleContentService: ArticleContentService;

  async *streamAgentic(
    history: ChatMessage[],
    context: { module?: string; articleKey?: string; mode?: string; extra?: string },
    userId: string
  ): AsyncGenerator<AgenticFrame> {
    const started = Date.now();
    const module = context.module || 'knowledge';
    const { key: modeKey, def: modeDef } = resolveMode(context.mode);
    const toolDefs = this.tools.getToolDefs(modeDef.tools);
    const maxRounds = modeDef.rounds;
    const toolCtx: ToolContext = { userId, module, citations: new Map() };

    let systemPrompt = buildAgenticSystemPrompt(module, modeDef.instructions);
    const rawMessages: any[] = [];

    // 模式携带的额外上下文（如做题审稿/急救的题目验收标准 + 指挥方案），由调用方拼好传入
    if (context.extra) {
      systemPrompt += `\n\n【本次上下文】\n${sanitizeForPrompt(context.extra, 3000)}`;
    }

    // 轮 0 快赢：文章页直接注入当前文章正文，多数「问这篇」问题无需工具
    if (context.articleKey) {
      try {
        const art = await this.articleContentService.get(module, context.articleKey);
        if (art?.content) {
          systemPrompt += `\n\n【用户当前正在阅读】《${art.title || context.articleKey}》(key=${context.articleKey})\n正文摘录：\n${sanitizeForPrompt(art.content, 2500)}`;
          toolCtx.citations.set(`${module}:${context.articleKey}`, {
            module,
            articleKey: context.articleKey,
            title: art.title || context.articleKey,
          });
        }
      } catch {
        /* 注入失败不影响主流程 */
      }
    }

    for (const m of history) {
      if (m.role === 'user' || m.role === 'assistant') {
        rawMessages.push({ role: m.role, content: m.content });
      }
    }

    yield* this.runLoop({
      systemPrompt,
      history,
      rawMessages,
      modeKey,
      maxRounds,
      toolDefs,
      toolCtx,
      module,
      userId,
      started,
    });
  }

  /** 跑工具循环并转成 SSE 帧：status / content / question / citations / error。 */
  private async *runLoop(p: {
    systemPrompt: string;
    history: ChatMessage[];
    rawMessages: { role: 'user' | 'assistant'; content: string }[];
    modeKey: string;
    maxRounds: number;
    toolDefs: any[];
    toolCtx: ToolContext;
    module: string;
    userId: string;
    started: number;
  }): AsyncGenerator<AgenticFrame> {
    const { history, module, userId, toolCtx } = p;
    let fallbackFlags: string[] = [];
    let tokenUsed = 0;
    let rounds = 0;
    let toolCallCount = 0;
    let status = 'success';
    let errorMsg: string | undefined;
    let answered = false;
    let asked = false;

    try {
      try {
        for await (const ev of runAiSdkLoop({
          config: {
            apiKey: this.proxy.aiConfig.apiKey,
            model: this.proxy.aiConfig.model,
          },
          systemPrompt: p.systemPrompt,
          messages: p.rawMessages,
          toolDefs: p.toolDefs,
          executeTool: (name, args) => this.tools.execute(name, args, toolCtx),
          maxRounds: p.maxRounds,
        })) {
          if (ev.type === 'status') yield { status: statusLabel(ev.toolName, ev.args) };
          else if (ev.type === 'content') yield { content: ev.text };
          else if (ev.type === 'question') {
            asked = true;
            yield { question: ev.question };
          } else if (ev.type === 'done') {
            answered = ev.answered;
            tokenUsed = ev.tokenUsed;
            rounds = ev.rounds;
            toolCallCount = ev.toolCallCount;
            fallbackFlags = ev.fallbackFlags;
          }
        }
      } catch (e: any) {
        // 引擎层失败（网络 / 上游 4xx5xx）：走降级链，不白屏
        fallbackFlags.push('call_error');
        errorMsg = e?.message;
        answered = false;
      }

      if (!asked) {
        if (!answered) {
          yield { status: '正在整理答案…' };
          yield* this.degradedAnswer(history, module, userId, toolCtx);
        }
        const citations = [...toolCtx.citations.values()].slice(0, 6);
        if (citations.length) yield { citations };
      }
      if (tokenUsed) await this.proxy.recordUsage(userId, module, tokenUsed).catch(() => {});
    } catch (e: any) {
      status = 'error';
      errorMsg = e?.message || String(e);
      yield { error: errorMsg };
    } finally {
      const lastUser = [...history].reverse().find((m) => m.role === 'user');
      const rate = Number(process.env.LLM_COST_PER_MTOKEN || '1');
      this.proxy
        .logAgenticCall({
          userId,
          module,
          mode: p.modeKey,
          inputSummary: lastUser?.content || '',
          latencyMs: Date.now() - p.started,
          tokenUsed,
          rounds,
          toolCallCount,
          fallbackFlags: fallbackFlags.length ? fallbackFlags : null,
          costEstimate: (tokenUsed / 1e6) * rate,
          retrievedRefs: [...toolCtx.citations.values()].map((c) => `${c.module}/${c.articleKey}`),
          status,
          errorMsg,
        })
        .catch(() => {});
    }
  }

  /** 降级链：单轮「检索 top3 注入」→ 流式普通回答（再失败则纯对话）。 */
  private async *degradedAnswer(
    history: ChatMessage[],
    module: string,
    userId: string,
    toolCtx: ToolContext
  ): AsyncGenerator<AgenticFrame> {
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    let sys = `${buildModulePersona(module)}\n\n请用中文回答，代码用 Markdown。`;
    if (lastUser?.content) {
      try {
        const hits = await this.retrieveService.retrieve(lastUser.content, { module, topK: 3 });
        if (hits.length) {
          sys +=
            '\n\n站内相关资料（优先基于它作答，末尾用「延伸阅读」列出引用；不足以回答就如实说）：\n' +
            hits.map((h, i) => `[${i + 1}] 《${h.title}》(key=${h.articleKey})`).join('\n');
          for (const h of hits) {
            toolCtx.citations.set(`${h.module}:${h.articleKey}`, {
              module: h.module,
              articleKey: h.articleKey,
              title: h.title,
            });
          }
        }
      } catch {
        /* 检索失败则纯对话 */
      }
    }
    const raw = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    try {
      for await (const chunk of this.proxy.streamFinal(sys, raw, module, userId)) {
        if (chunk.content) yield { content: chunk.content };
      }
    } catch (e: any) {
      yield { error: e?.message || 'AI 请求失败' };
    }
  }
}
