import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { CopilotRuntime, copilotRuntimeNodeHttpEndpoint } from '@copilotkit/runtime';
import { makeDeepseekAgent } from '../copilot/deepseekAgent';
import { NoAuth } from '../decorator/noAuth';

/**
 * CopilotKit v2 runtime 端点。前端 <CopilotKit runtimeUrl=".../copilotkit"> 接入此处。
 *
 * 单路由协议：POST JSON 信封 { method, params, body }；method ∈
 * agent/run | agent/connect | agent/stop | info | transcribe。响应为 SSE 事件流。
 * 默认 agent 由 DeepSeek 驱动（见 deepseekAgent.ts）。
 */
const ENDPOINT = '/copilotkit';

let handler: ((req: any, res: any, next?: any) => Promise<void>) | null = null;

function getHandler() {
  if (!handler) {
    const runtime = new CopilotRuntime({ agents: { default: makeDeepseekAgent() } } as any);
    handler = copilotRuntimeNodeHttpEndpoint({
      endpoint: ENDPOINT,
      runtime,
    }) as any;
  }
  return handler!;
}

@Provide()
export class CopilotHTTPService {
  @Inject()
  ctx: Context;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'CopilotKit runtime（可行性验证）',
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
    // CopilotKit node-http 集成在检测到流已被消费时，会改用 req.body 重建请求，
    // 故把解析结果挂到 req.body 上，避免读不到请求体。
    if (req.body === undefined) {
      req.body = (this.ctx.request as any)?.body;
    }
    await getHandler()(req, res);
  }
}
