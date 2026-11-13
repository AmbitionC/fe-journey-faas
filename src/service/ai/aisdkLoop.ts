/**
 * Iris 教练工具循环：用 Vercel AI SDK 驱动与 DeepSeek 的多轮工具调用（2026-11-10 起全量，旧的手写循环已删除）。
 *
 * 只负责「怎么跟模型多轮对话」这一层；模式注册、工具实现、引用、降级链、计费、aiCallLog
 * 由 CoachAgentService 负责。这里是纯函数，不依赖 Midway 容器，便于单测和离线评测。
 * 工具轮开启思考（DeepSeek「思考 + 工具」要求回传 reasoning_content，@ai-sdk/deepseek 自动处理）；
 * 终答就是最后一步的流式输出。
 *
 * 兜底五件套的对应关系：
 * ① 去重熔断：同名同参二次调用 → 返回提示 + 下一步收掉工具，强制终答（dedup_stop）
 * ② 文本化工具调用：模型把调用写进正文（JSON，或 `<｜DSML｜invoke …>` 这类标签）→ 不展示给用户，交由调用方走降级链（textual_parse）
 * ③ 空响应：没有终答正文 → 调用方走降级链（final_fallback）
 * ④ 轮数用尽：最后一步收掉工具，模型只能作答（rounds_exhausted）
 * ⑤ 参数自纠：AI SDK 对坏 JSON 会自动报给模型修正（invalid tool input 走 SDK 的修复回路）
 */
import { streamText, jsonSchema, stepCountIs, ModelMessage } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';

export interface LoopConfig {
  apiKey: string;
  model: string;
  /** 默认 https://api.deepseek.com ；单测 / 评测可指向模拟服务 */
  baseURL?: string;
  /** 是否开启思考（默认 true；仅单测 / 评测会关） */
  thinking?: boolean;
  /** 单步最大输出 token（默认 2048） */
  maxOutputTokens?: number;
  /** 单测注入 */
  fetch?: typeof globalThis.fetch;
}

/** OpenAI function-calling 格式的工具定义（CoachToolsService.getToolDefs 的产物）。 */
export interface OpenAiToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: any };
}

export type LoopEvent =
  | { type: 'status'; toolName: string; args: any }
  | { type: 'content'; text: string }
  | { type: 'question'; question: { question: string; options: string[]; allowFreeText: boolean } }
  | {
      type: 'done';
      /** 正常产出了终答正文（或已发问）；false 表示调用方应走降级链 */
      answered: boolean;
      tokenUsed: number;
      cacheHitTokens: number;
      reasoningTokens: number;
      rounds: number;
      toolCallCount: number;
      fallbackFlags: string[];
    };

/** 一步里的正文先攒这么多字再放给用户：期间若出现工具调用，就说明这段是「我先查一下」之类的过场话，丢弃。 */
const HOLD_CHARS = 40;

/** 「我先查一下 / 让我检索一下……」这类过场话：长度可能超过 HOLD_CHARS，按句式识别，整句不展示。 */
const PREFACE_RE = /^\s*(好的[，,]?\s*)?(我先|让我先?|我来|先)(去)?(查|检索|搜|搜索|看|翻|读|找|了解)[^。！？\n]{0,80}[。！？.!?…]+\s*/;

/** 去掉开头的过场话（纯函数，便于单测）。 */
export function stripPreface(text: string): string {
  return text.replace(PREFACE_RE, '');
}

function looksLikeTextualToolCall(text: string, toolNames: string[]): boolean {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('```'))) return false;
  return toolNames.some((n) => t.includes(`"${n}"`));
}

/**
 * 模型把工具调用写成标签文本的几种写法（DeepSeek 偶发的 `<｜DSML｜function_calls>` / `<｜DSML｜invoke name="…">`，
 * 以及通用的 `<function_calls>` / `<invoke name=…>` / `<tool_call>`）。比较前先去掉 `<` 后面的竖线和空白。
 */
const TOOL_MARKUP_HEADS = ['DSML', 'invokename=', 'function_calls', 'tool_call'];
/** 标签开头最多看这么多字符；超过还对不上就当普通的 `<`（比如代码里的泛型） */
const TOOL_MARKUP_SCAN = 24;

/**
 * 在正文里找工具调用标签（纯函数，便于单测）。
 * - emit：可以放给用户的部分；
 * - keep：结尾那段还分不清是不是标签开头的文字，先扣着，等后面的字到了再判断；
 * - textual：确认出现了标签，标签起的内容全部不展示。
 */
export function splitAtToolMarkup(buf: string): { emit: string; keep: string; textual: boolean } {
  let from = 0;
  for (;;) {
    const i = buf.indexOf('<', from);
    if (i < 0) return { emit: buf, keep: '', textual: false };
    const head = buf.slice(i + 1, i + 1 + TOOL_MARKUP_SCAN).replace(/[｜|\s]/g, '');
    if (TOOL_MARKUP_HEADS.some((h) => head.startsWith(h))) {
      return { emit: buf.slice(0, i), keep: '', textual: true };
    }
    const atTail = buf.length - i - 1 < TOOL_MARKUP_SCAN;
    if (atTail && TOOL_MARKUP_HEADS.some((h) => h.startsWith(head))) {
      return { emit: buf.slice(0, i), keep: buf.slice(i), textual: false };
    }
    from = i + 1;
  }
}

/** 标签之前只说了这么点字就转去写工具调用：算没答上，交给降级链重新回答 */
const TEXTUAL_MIN_ANSWER = 120;

export async function* runAiSdkLoop(opts: {
  config: LoopConfig;
  systemPrompt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  toolDefs: OpenAiToolDef[];
  /** 执行一个工具，返回给模型读的文本 */
  executeTool: (name: string, args: any) => Promise<string>;
  /** 工具轮数上限（与模式注册表 rounds 一致）；终答另占一步 */
  maxRounds: number;
}): AsyncGenerator<LoopEvent> {
  const { config, toolDefs, executeTool, maxRounds } = opts;
  const deepseek = createDeepSeek({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });

  const fallbackFlags: string[] = [];
  const seen = new Set<string>();
  let toolCallCount = 0;
  let forceFinal = false;
  const toolNames = toolDefs.map((t) => t.function.name);

  const tools: Record<string, any> = {};
  for (const def of toolDefs) {
    const name = def.function.name;
    const base = {
      description: def.function.description || '',
      inputSchema: jsonSchema(def.function.parameters || { type: 'object', properties: {} }),
    };
    if (name === 'ask_question') {
      // 无 execute：模型一调用，SDK 就停在这一步，交给我们发 question 帧
      tools[name] = base;
      continue;
    }
    tools[name] = {
      ...base,
      execute: async (args: any) => {
        const sig = `${name}:${JSON.stringify(args ?? {})}`;
        if (seen.has(sig)) {
          if (!fallbackFlags.includes('dedup_stop')) fallbackFlags.push('dedup_stop');
          forceFinal = true;
          return '（已查询过相同内容，请基于已有信息直接作答）';
        }
        seen.add(sig);
        toolCallCount++;
        try {
          return String(await executeTool(name, args ?? {})).slice(0, 4000);
        } catch (e: any) {
          return `工具执行出错：${e?.message || e}`;
        }
      },
    };
  }

  const abort = new AbortController();
  const finalStep = maxRounds; // stepNumber 从 0 开始：0..maxRounds-1 可用工具，第 maxRounds 步只能作答
  const result = streamText({
    model: deepseek(config.model),
    system: opts.systemPrompt,
    messages: opts.messages as ModelMessage[],
    tools,
    maxOutputTokens: config.maxOutputTokens ?? 2048,
    maxRetries: 1,
    abortSignal: abort.signal,
    stopWhen: stepCountIs(maxRounds + 1),
    providerOptions: { deepseek: { thinking: { type: config.thinking === false ? 'disabled' : 'enabled' } } },
    prepareStep: ({ stepNumber }) => {
      if (forceFinal || stepNumber >= finalStep) {
        if (stepNumber >= finalStep && !forceFinal && !fallbackFlags.includes('rounds_exhausted')) {
          fallbackFlags.push('rounds_exhausted');
        }
        return { activeTools: [] };
      }
      return undefined;
    },
  });

  let answeredText = '';
  let asked = false;
  let rounds = 0;
  // 每一步的正文缓冲（见 HOLD_CHARS）
  let stepBuf = '';
  let stepFlushed = false;
  let stepHasTool = false;
  let stepTextual = false;
  let lastStepTextual = false;

  for await (const part of result.fullStream as AsyncIterable<any>) {
    switch (part.type) {
      case 'start-step':
        stepBuf = '';
        stepFlushed = false;
        stepHasTool = false;
        stepTextual = false;
        break;
      case 'text-delta': {
        const delta: string = part.text ?? part.delta ?? '';
        if (!delta || stepHasTool || stepTextual) break;
        stepBuf += delta;
        if (stepFlushed) {
          // 已经在往外放正文：每次只放确认不是工具调用标签的部分
          const cut = splitAtToolMarkup(stepBuf);
          if (cut.emit) {
            answeredText += cut.emit;
            yield { type: 'content', text: cut.emit };
          }
          stepBuf = cut.keep;
          if (cut.textual) stepTextual = true;
          break;
        }
        if (looksLikeTextualToolCall(stepBuf, toolNames)) {
          stepTextual = true;
          break;
        }
        {
          // 还没开始放正文就出现了标签：标签前的话多半是过场话，剥掉后有剩才展示
          const cut = splitAtToolMarkup(stepBuf);
          if (cut.textual) {
            const before = stripPreface(cut.emit);
            if (before.trim()) {
              answeredText += before;
              yield { type: 'content', text: before };
            }
            stepBuf = '';
            stepTextual = true;
            break;
          }
        }
        // 过场话开头：等这句说完再判断（说完就剥掉），没说完先别放
        const looksPreface = /^\s*(好的[，,]?\s*)?(我先|让我先?|我来|先)(去)?(查|检索|搜|看|翻|读|找|了解)/.test(stepBuf);
        if (looksPreface) {
          const stripped = stripPreface(stepBuf);
          if (stripped === stepBuf) break; // 这句还没说完
          stepBuf = stripped;
        }
        if (stepBuf.length >= HOLD_CHARS && !stepBuf.trim().startsWith('{') && !stepBuf.trim().startsWith('```')) {
          stepFlushed = true;
          const cut = splitAtToolMarkup(stepBuf);
          if (cut.emit) {
            answeredText += cut.emit;
            yield { type: 'content', text: cut.emit };
          }
          stepBuf = cut.keep;
        }
        break;
      }
      case 'tool-input-start':
        stepHasTool = true;
        break;
      case 'tool-call': {
        stepHasTool = true;
        if (part.toolName === 'ask_question') {
          const qa = part.input || {};
          const options = Array.isArray(qa.options) ? qa.options.map((o: any) => String(o)).slice(0, 4) : [];
          yield {
            type: 'question',
            question: {
              question: String(qa.question || '').slice(0, 500),
              options,
              allowFreeText: qa.allowFreeText !== false,
            },
          };
          asked = true;
        } else {
          yield { type: 'status', toolName: part.toolName, args: part.input };
        }
        break;
      }
      case 'finish-step': {
        rounds++;
        // 没攒满就结束的短答案：此时才能确认这一步没调工具
        if (!stepFlushed && !stepHasTool && stepBuf) {
          if (looksLikeTextualToolCall(stepBuf, toolNames)) {
            stepTextual = true;
          } else {
            const rest = stripPreface(stepBuf);
            if (rest.trim()) {
              answeredText += rest;
              yield { type: 'content', text: rest };
            }
          }
          stepBuf = '';
        } else if (stepFlushed && !stepHasTool && !stepTextual && stepBuf) {
          // 结尾扣着的那几个字最后也没变成标签，照常放出去
          answeredText += stepBuf;
          yield { type: 'content', text: stepBuf };
          stepBuf = '';
        }
        if (stepTextual && !fallbackFlags.includes('textual_parse')) fallbackFlags.push('textual_parse');
        lastStepTextual = stepTextual;
        break;
      }
      case 'error':
        throw part.error instanceof Error ? part.error : new Error(String(part.error?.message || part.error));
      default:
        break;
    }
    if (asked) break;
  }
  if (asked) {
    // 发问即结束本轮：掐掉后续流，并吞掉被掐断后各个 Promise 的拒绝，避免 unhandledRejection
    abort.abort();
    for (const p of [result.totalUsage, result.text, result.steps] as Promise<any>[]) p.then(undefined, () => {});
  }

  let tokenUsed = 0;
  let cacheHitTokens = 0;
  let reasoningTokens = 0;
  if (!asked) {
    try {
      const usage: any = await result.totalUsage;
      tokenUsed = usage?.totalTokens || 0;
      cacheHitTokens = usage?.inputTokenDetails?.cacheReadTokens || 0;
      reasoningTokens = usage?.outputTokenDetails?.reasoningTokens || 0;
    } catch {
      /* 计量失败不影响回答 */
    }
  }

  // 最后一步写成了工具调用标签、此前又没说出像样的内容：按没答上处理，调用方走降级链把问题答完
  const cutShort = lastStepTextual && answeredText.trim().length < TEXTUAL_MIN_ANSWER;
  const answered = asked || (answeredText.trim().length > 0 && !cutShort);
  if (!answered && !fallbackFlags.includes('final_fallback')) fallbackFlags.push('final_fallback');
  yield { type: 'done', answered, tokenUsed, cacheHitTokens, reasoningTokens, rounds, toolCallCount, fallbackFlags };
}
