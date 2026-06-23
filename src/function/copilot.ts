import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { NoAuth } from '../decorator/noAuth';

/**
 * CopilotKit v2 runtime 端点。前端 <CopilotKit runtimeUrl=".../copilotkit"> 接入此处。
 *
 * 单路由协议：POST JSON 信封 { method, params, body }；响应为 SSE 事件流。
 *
 * ⚠️ 全部 copilotkit / ai-sdk 依赖仅在首次请求时**动态加载**，且不拆出独立模块——
 * 因为 Midway 启动会 require dist 下所有文件，任何顶层 `import '@copilotkit/*'`
 * 都会在 bootstrap 期触发 ERR_REQUIRE_ESM（node-fetch-handler 内部 require ESM-only
 * 包，Node<22.12 不支持），从而拖垮整个应用。内联+动态加载把风险隔离在本端点内。
 * 运行时需 Node ≥ 22.12（见 deploy.yml）。
 */
const ENDPOINT = '/copilotkit';

let handlerPromise: Promise<(req: any, res: any, next?: any) => Promise<void>> | null =
  null;

function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const { CopilotRuntime, copilotRuntimeNodeHttpEndpoint } = await import(
        '@copilotkit/runtime'
      );
      const { BuiltInAgent } = await import('@copilotkit/runtime/v2');
      const { createOpenAI } = await import('@ai-sdk/openai');

      // DeepSeek（OpenAI 兼容 Chat Completions）。必须用 .chat() 强制 Chat Completions——
      // 默认 provider(model) 走 Responses API，DeepSeek 无该端点 → 404。
      const deepseek = createOpenAI({
        apiKey: process.env.LLM_API_KEY,
        baseURL: 'https://api.deepseek.com',
      });
      const agent = new (BuiltInAgent as any)({
        model: deepseek.chat(process.env.LLM_MODEL || 'deepseek-chat'),
      });
      const runtime = new CopilotRuntime({ agents: { default: agent } } as any);
      return copilotRuntimeNodeHttpEndpoint({
        endpoint: ENDPOINT,
        runtime,
      }) as any;
    })();
  }
  return handlerPromise;
}

@Provide()
export class CopilotHTTPService {
  @Inject()
  ctx: Context;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'CopilotKit runtime',
    functionName: 'copilotkit',
    name: 'copilotkit',
    path: '/copilotkit',
    method: 'post',
  })
  @NoAuth()
  async copilot(@Body(ALL) body: any) {
    // 经 Midway 正常响应通道（ctx.body）返回，不劫持 ctx.res、不 respond=false。
    // copilotkit 响应整体缓冲后返回（首版不做真流式；前端 SSE 解析可一次性吃完整 body）。
    const parsedBody = body ?? {};
    try {
      const handler = await getHandler();
      const request = new Request('http://fc.local/copilotkit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsedBody),
      });
      const response: any = await (handler as any)(request);
      const buf = Buffer.from(await response.arrayBuffer());
      this.ctx.status = response.status || 200;
      const ct = response.headers.get('content-type');
      if (ct) this.ctx.set('Content-Type', ct);
      this.ctx.body = buf;
    } catch (err: any) {
      handlerPromise = null; // 失败不缓存，下次重试
      this.ctx.status = 500;
      this.ctx.body = {
        error: 'copilot_error',
        message: String(err?.message || err),
        stack: String(err?.stack || '').split('\n').slice(0, 8).join(' | '),
      };
    }
  }
}
