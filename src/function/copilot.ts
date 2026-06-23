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
    description: 'copilot probe',
    functionName: 'copilotprobe',
    name: 'copilotprobe',
    path: '/copilotprobe',
    method: 'post',
  })
  @NoAuth()
  async copilotProbe(@Body(ALL) body: any) {
    const ret = String(body?.ret || 'obj'); // 'str' | 'obj'
    const cp: any = await import('@copilotkit/runtime');
    const v2: any = await import('@copilotkit/runtime/v2');
    const ai: any = await import('@ai-sdk/openai');
    const deepseek = ai.createOpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: 'https://api.deepseek.com',
    });
    const agent = new v2.BuiltInAgent({
      model: deepseek.chat(process.env.LLM_MODEL || 'deepseek-chat'),
    });
    const runtime = new cp.CopilotRuntime({ agents: { default: agent } });
    const handler = cp.copilotRuntimeNodeHttpEndpoint({ endpoint: ENDPOINT, runtime });
    const request = new Request('http://fc.local/copilotkit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'info', params: {}, body: {} }),
    });
    const response = await handler(request);
    const text = await response.text();
    // ret=str → 返回字符串；ret=obj → 返回对象。判断 FaaS 是否因返回字符串而崩。
    if (ret === 'str') return text;
    return { ok: true, len: text.length };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'CopilotKit runtime',
    functionName: 'copilotkit',
    name: 'copilotkit',
    path: '/copilotkit',
    method: 'post',
  })
  @NoAuth()
  async copilot(@Body(ALL) body: any) {
    // 在 Midway FaaS 里，唯一不让响应适配器崩溃的方式是「纯 return 值」——
    // 任何 ctx.status/type/body 或 respond=false+裸res 都会 Process exited。
    // 故整体缓冲 copilotkit 响应后直接 return 文本（首版不做真流式）。
    const parsedBody = body ?? {};
    try {
      const handler = await getHandler();
      const request = new Request(`http://fc.local${ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsedBody),
      });
      const response: any = await handler(request);
      return await response.text();
    } catch (err: any) {
      handlerPromise = null; // 失败不缓存，下次重试
      return JSON.stringify({ error: 'copilot_error', message: String(err?.message || err) });
    }
  }
}
