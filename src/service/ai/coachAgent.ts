import { Provide, Inject } from '@midwayjs/core';
import { AiProxyService, ChatMessage, ToolCall, buildModulePersona } from './proxy';
import { CoachToolsService, ToolContext, Citation } from './coachTools';
import { RetrieveService } from './retrieve';
import { ArticleContentService } from '../content/articleContent';
import { sanitizeForPrompt } from './sanitize';

/** agentic loop 向外产出的 SSE 事件帧。 */
export interface AgenticFrame {
  status?: string;
  content?: string;
  citations?: Citation[];
  error?: string;
}

const MAX_ROUNDS = 4;

/** agentic 指令 + 教练边界（PRD-04 F7）：拼在模块画像之后作为系统提示词。 */
const AGENTIC_INSTRUCTIONS = `\n\n你能调用工具检索站内知识库来支撑回答。工作方式：
1. 回答站内知识问题前，优先用 search_articles 找依据；需要原文细节再 read_article；想做跨文章推荐用 get_catalog；要个性化就先 get_learner_state。
2. 回答必须基于站内资料，末尾用「延伸阅读」列出引用到的文章标题；站内确实没有就如实说明、绝不编造 API 或数字。
3. 用中文，代码用 Markdown。先给最关键的一句，再按需展开。`;

const COACH_BOUNDARY = `\n\n（重要边界）你是考官与学习向导，不是代码助手：不要输出成品代码、不替用户调试报错、不给可以直接粘贴运行的完整实现——这些用户自己的 IDE AI（Cursor / Claude Code）做得又快又好。你专注做它们做不到的事：对照站内知识判断用户的方向/方案对不对、指出他还缺哪块知识（并给出站内文章）、教他怎么把需求向 AI 说清楚。`;

function buildAgenticSystemPrompt(module: string): string {
  return `${buildModulePersona(module)}${AGENTIC_INSTRUCTIONS}${COACH_BOUNDARY}`;
}

/** status 帧文案：把工具调用翻译成用户看得懂的「正在做什么」。 */
function statusLabel(name: string, args: any): string {
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

/** 兜底②：模型把工具调用写进正文时，尽力从文本里解析出一个调用。 */
function tryParseTextualToolCall(text: string): ToolCall | null {
  if (!text) return null;
  const known = ['search_articles', 'read_article', 'get_catalog', 'get_learner_state'];
  // 找第一个包含 name 字段的 JSON 对象
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      const name = obj.name || obj.tool || obj.function;
      if (name && known.includes(name)) {
        const argObj = obj.arguments || obj.parameters || obj.args || {};
        return { id: name, name, arguments: typeof argObj === 'string' ? argObj : JSON.stringify(argObj) };
      }
    } catch {
      /* 非 JSON，继续 */
    }
  }
  return null;
}

/**
 * 教练 agentic loop（PRD-04 F4 / 检索设计 §3）。
 * 一套工具驱动的多轮循环：模型自主决定查什么，服务端执行工具、推 status 帧，
 * 最终流式产出带引用的答案。自带兜底五件套 + 降级链，DeepSeek 多轮 FC 故障不白屏。
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
    context: { module?: string; articleKey?: string },
    userId: string
  ): AsyncGenerator<AgenticFrame> {
    const started = Date.now();
    const module = context.module || 'knowledge';
    const toolCtx: ToolContext = { userId, module, citations: new Map() };
    const fallbackFlags: string[] = [];
    let toolCallCount = 0;
    let tokenUsed = 0;
    let status = 'success';
    let errorMsg: string | undefined;

    let systemPrompt = buildAgenticSystemPrompt(module);
    const rawMessages: any[] = [];

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

    const seenCalls = new Set<string>();
    let emptyRetried = false;
    let degraded = false;
    let forceFinal = false;
    let round = 0;

    try {
      for (round = 0; round < MAX_ROUNDS && !forceFinal; round++) {
        let turn;
        try {
          turn = await this.proxy.chatWithTools(systemPrompt, rawMessages, this.tools.getToolDefs(), {
            userId,
            module,
            toolChoice: 'auto',
          });
        } catch (e: any) {
          fallbackFlags.push('call_error');
          errorMsg = e?.message;
          degraded = true;
          break;
        }
        tokenUsed += turn.totalTokens;

        // 兜底③ 空响应重试一次
        if (!turn.content && turn.toolCalls.length === 0) {
          if (!emptyRetried) {
            emptyRetried = true;
            fallbackFlags.push('empty_retry');
            round--;
            continue;
          }
          degraded = true;
          break;
        }

        // 结构化 tool_calls；无则兜底② 文本化解析
        let calls: ToolCall[] = turn.toolCalls;
        if (calls.length === 0 && turn.content) {
          const parsed = tryParseTextualToolCall(turn.content);
          if (parsed) {
            calls = [parsed];
            fallbackFlags.push('textual_parse');
          }
        }

        // 模型不再调工具 → 进入终答
        if (calls.length === 0) break;

        // 记录 assistant 的 tool_calls 轮（OpenAI 格式，供下一轮上下文）
        rawMessages.push({
          role: 'assistant',
          content: turn.content || '',
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        for (const call of calls) {
          // 兜底① 去重熔断：同名同参重复调用即停并强制终答
          const sig = `${call.name}:${call.arguments}`;
          if (seenCalls.has(sig)) {
            fallbackFlags.push('dedup_stop');
            rawMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: '（已查询过相同内容，请基于已有信息直接作答）',
            });
            forceFinal = true;
            continue;
          }
          seenCalls.add(sig);
          toolCallCount++;

          // 兜底⑤ 参数自纠
          let args: any = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            args = salvageArgs(call.arguments);
            fallbackFlags.push('param_fix');
          }

          yield { status: statusLabel(call.name, args) };

          let toolResult = '';
          try {
            toolResult = await this.tools.execute(call.name, args, toolCtx);
          } catch (e: any) {
            toolResult = `工具执行出错：${e?.message || e}`;
          }
          rawMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: String(toolResult).slice(0, 4000),
          });
        }
      }

      // 兜底④ 强制终答 + 降级链
      if (degraded) {
        yield { status: '正在整理答案…' };
        yield* this.degradedAnswer(history, module, userId, toolCtx);
      } else {
        yield { status: '正在整理答案…' };
        let anyContent = false;
        try {
          for await (const chunk of this.proxy.streamFinal(systemPrompt, rawMessages, module, userId)) {
            if (chunk.content) {
              anyContent = true;
              yield { content: chunk.content };
            }
          }
        } catch (e: any) {
          errorMsg = e?.message;
          anyContent = false;
        }
        if (!anyContent) {
          fallbackFlags.push('final_fallback');
          yield* this.degradedAnswer(history, module, userId, toolCtx);
        }
      }

      const citations = [...toolCtx.citations.values()].slice(0, 6);
      if (citations.length) yield { citations };
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
          mode: context.articleKey ? 'qa_article' : 'qa',
          inputSummary: lastUser?.content || '',
          latencyMs: Date.now() - started,
          tokenUsed,
          rounds: round,
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

/** 兜底⑤：坏 JSON 参数里尽力捞出 query。 */
function salvageArgs(raw: string): any {
  if (!raw) return {};
  const m = raw.match(/"?query"?\s*[:：]\s*"?([^",}\n]+)/);
  if (m) return { query: m[1].trim() };
  return {};
}
