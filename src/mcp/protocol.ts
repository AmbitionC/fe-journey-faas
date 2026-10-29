/**
 * 最小 MCP 服务端（Streamable HTTP · 无状态模式）的 JSON-RPC 处理核心。
 *
 * 为什么手写而不用 @modelcontextprotocol/sdk：SDK 是 ESM 子路径导出，本仓库
 * tsconfig 是 commonjs + moduleResolution "node"（TS 5.1），子路径解析不可靠；
 * 而我们只需要 initialize / ping / tools/list / tools/call 四个方法，
 * 一百来行就能写全，且不引入依赖、不碰现有构建。
 *
 * 本模块是纯函数：不碰 HTTP、不碰数据库，方便单测。HTTP 适配在 ./http.ts。
 */

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC 标准错误码 */
export const RpcError = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export interface ToolDef<D = any> {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, any>;
  /** 返回值会被序列化为 JSON 文本给 Agent；抛错＝工具执行失败（isError=true）。 */
  handler: (args: Record<string, any>, deps: D) => Promise<any>;
}

export interface ServerSpec<D = any> {
  name: string;
  version: string;
  instructions: string;
  tools: ToolDef<D>[];
}

/** 每次 tools/call 的执行记录，交给调用方落日志。 */
export interface CallRecord {
  tool: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** 单条结果文本上限：防止一次调用把 Agent 的上下文塞爆。 */
export const MAX_TEXT_CHARS = 120_000;

/** 对外的工具出错文案：只给业务报错原文，不泄漏堆栈。 */
export class ToolError extends Error {}

function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: any, result: any) {
  return { jsonrpc: '2.0', id, result };
}

function toToolResult(data: any) {
  let text = JSON.stringify(data, null, 2);
  if (text === undefined) text = 'null';
  if (text.length > MAX_TEXT_CHARS) {
    text =
      text.slice(0, MAX_TEXT_CHARS) +
      `\n…（结果过长已截断，共 ${text.length} 字符；请缩小查询范围）`;
  }
  const out: any = { content: [{ type: 'text', text }] };
  // structuredContent 必须是对象；数组/原始值只走文本
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    text.length <= MAX_TEXT_CHARS
  ) {
    out.structuredContent = data;
  }
  return out;
}

/** 必填参数校验（只校验 required 与基础类型，够用即可）。返回错误文案或 null。 */
export function validateArgs(
  schema: Record<string, any>,
  args: Record<string, any>
): string | null {
  const required: string[] = schema?.required || [];
  for (const k of required) {
    if (args[k] === undefined || args[k] === null || args[k] === '')
      return `缺少必填参数 ${k}`;
  }
  const props = schema?.properties || {};
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p || v === undefined || v === null) continue;
    const t = p.type;
    if (t === 'string' && typeof v !== 'string') return `参数 ${k} 应为字符串`;
    if (
      (t === 'integer' || t === 'number') &&
      (typeof v !== 'number' || Number.isNaN(v))
    ) {
      return `参数 ${k} 应为数字`;
    }
    if (t === 'integer' && !Number.isInteger(v)) return `参数 ${k} 应为整数`;
    if (p.enum && !p.enum.includes(v))
      return `参数 ${k} 只能是 ${p.enum.join(' / ')}`;
  }
  return null;
}

/**
 * 处理一条 JSON-RPC 消息。
 * @returns 响应对象；通知/客户端回包（无需响应）返回 null。
 */
export async function handleMessage<D>(
  msg: any,
  spec: ServerSpec<D>,
  deps: D,
  onCall?: (rec: CallRecord) => Promise<void> | void
): Promise<any | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id, RpcError.INVALID_REQUEST, 'Invalid Request');
  }
  // 客户端发来的 response（无 method）或通知（无 id）：不回包
  if (typeof msg.method !== 'string') return null;
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;

  const { id, method } = msg;
  const params = msg.params || {};

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: spec.name, version: spec.version },
        instructions: spec.instructions,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: spec.tools.map(t => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = params.name;
      const tool = spec.tools.find(t => t.name === name);
      if (!tool)
        return rpcError(id, RpcError.INVALID_PARAMS, `未知工具：${name}`);
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? params.arguments
          : {};
      const invalid = validateArgs(tool.inputSchema, args);
      const t0 = Date.now();
      if (invalid) {
        await safe(onCall, {
          tool: name,
          ok: false,
          latencyMs: 0,
          error: invalid,
        });
        return rpcResult(id, {
          content: [{ type: 'text', text: invalid }],
          isError: true,
        });
      }
      try {
        const data = await tool.handler(args, deps);
        await safe(onCall, {
          tool: name,
          ok: true,
          latencyMs: Date.now() - t0,
        });
        return rpcResult(id, toToolResult(data));
      } catch (e: any) {
        const message =
          e instanceof ToolError
            ? e.message
            : (e?.message || '工具执行失败').slice(0, 300);
        await safe(onCall, {
          tool: name,
          ok: false,
          latencyMs: Date.now() - t0,
          error: message,
        });
        return rpcResult(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(
        id,
        RpcError.METHOD_NOT_FOUND,
        `Method not found: ${method}`
      );
  }
}

async function safe(fn: ((r: CallRecord) => any) | undefined, rec: CallRecord) {
  if (!fn) return;
  try {
    await fn(rec);
  } catch {
    /* 记账失败不影响调用结果 */
  }
}
