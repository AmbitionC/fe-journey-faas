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
 * 单路由协议：POST JSON 信封 { method, params, body }；响应为 SSE 事件流。
 *
 * 踩坑记录（FC3 web 函数 + Midway FaaS）：
 *  1. copilotkit 内部 require() ESM-only 包，需 Node ≥ 22.12（见 deploy.yml）；且
 *     不能顶层 import（Midway 启动 require 全部文件会在 bootstrap 期触发 ERR_REQUIRE_ESM
 *     拖垮全站），故仅首次请求时动态 import。
 *  2. 在 Midway FaaS 里设 ctx.status/ctx.type/ctx.body 会让响应适配器崩溃（Process exited）。
 *     唯一可用的自定义/流式响应方式是 respond=false + 裸 ctx.res（与 aiChatStream 同款）。
 *  3. 必须 @Body(ALL) 消费请求体，否则未读的 POST 流也会让 FC 杀实例。
 */
const ENDPOINT = '/copilotkit';

let handlerPromise: Promise<(reqOrRequest: any, res?: any) => any> | null = null;

function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const { CopilotRuntime, copilotRuntimeNodeHttpEndpoint } = await import(
        '@copilotkit/runtime'
      );
      const { BuiltInAgent } = await import('@copilotkit/runtime/v2');
      const { createOpenAI } = await import('@ai-sdk/openai');

      // DeepSeek（OpenAI 兼容）。必须用 .chat() 强制 Chat Completions——
      // 默认 provider(model) 走 Responses API，DeepSeek 无该端点 → 404。
      const deepseek = createOpenAI({
        apiKey: process.env.LLM_API_KEY,
        baseURL: 'https://api.deepseek.com',
      });
      const agent = new (BuiltInAgent as any)({
        model: deepseek.chat(process.env.LLM_MODEL || 'deepseek-chat'),
      });
      const runtime = new CopilotRuntime({ agents: { default: agent } } as any);
      return copilotRuntimeNodeHttpEndpoint({ endpoint: ENDPOINT, runtime }) as any;
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
    const parsedBody = body ?? {};
    // 关键：所有响应头必须在第一次 await / res.write 之前设好（与 aiChatStream 同款时序）。
    const isStream =
      parsedBody.method === 'agent/run' || parsedBody.method === 'agent/connect';
    this.ctx.set(
      'Content-Type',
      isStream ? 'text/event-stream; charset=utf-8' : 'application/json',
    );
    this.ctx.set('Cache-Control', 'no-cache');
    this.ctx.set('Connection', 'keep-alive');
    this.ctx.set('X-Accel-Buffering', 'no');
    (this.ctx as any).respond = false;
    const res: any = this.ctx.res;
    const decoder = new TextDecoder();
    try {
      const handler = await getHandler();
      const request = new Request(`http://fc.local${ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsedBody),
      });
      const response: any = await handler(request);
      const reader = response.body?.getReader?.();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(decoder.decode(value, { stream: true }));
        }
      } else {
        res.write(await response.text());
      }
      res.end();
    } catch (err: any) {
      handlerPromise = null; // 失败不缓存，下次重试
      try {
        res.write(
          JSON.stringify({ error: 'copilot_error', message: String(err?.message || err) }),
        );
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}
