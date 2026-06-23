import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { NoAuth } from '../decorator/noAuth';

/**
 * CopilotKit v2 runtime 端点。前端 <CopilotKit runtimeUrl=".../copilotkit"> 接入此处。
 *
 * 单路由协议：POST JSON 信封 { method, params, body }；响应为 SSE 事件流。
 * 默认 agent 由 DeepSeek 驱动（见 deepseekAgent.ts）。
 *
 * ⚠️ 懒加载：@copilotkit/runtime 的 node-fetch-handler 内部 require() 了 ESM-only 的
 * @remix-run/node-fetch-server，Node < 22.12 会抛 ERR_REQUIRE_ESM。为避免该错误在
 * 模块加载期拖垮整个应用 bootstrap，copilotkit 仅在首次请求时动态加载——即使运行时
 * 不兼容，也只影响本端点，不影响其它接口。运行时需 Node ≥ 22.12（见 deploy.yml）。
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
      const { makeDeepseekAgent } = await import('../copilot/deepseekAgent');
      const runtime = new CopilotRuntime({
        agents: { default: makeDeepseekAgent() },
      } as any);
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
  async copilot() {
    // 绕过 Midway/Koa 的响应序列化，把响应控制权交给 CopilotKit 的 handler
    (this.ctx as any).respond = false;
    const req: any = this.ctx.req;
    const res: any = this.ctx.res;
    // Midway 会先把 POST body 解析到 ctx.request.body 并消费掉 req 流。
    // CopilotKit node-http 集成在检测到流已被消费时，会改用 req.body 重建请求。
    if (req.body === undefined) {
      req.body = (this.ctx.request as any)?.body;
    }
    try {
      const handler = await getHandler();
      await handler(req, res);
    } catch (err: any) {
      handlerPromise = null; // 加载失败不缓存，下次重试
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(
        JSON.stringify({ error: 'copilot_unavailable', message: err?.message || 'error' }),
      );
    }
  }
}
