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
 * 单路由协议：POST JSON 信封 { method, params, body }。
 *
 * 踩坑记录（FC3 web 函数 + Midway FaaS，逐条都验证过）：
 *  1. copilotkit 内部 require() ESM-only 包，需 Node ≥ 22.12（见 deploy.yml）；且不能
 *     顶层 import（Midway 启动 require 全部文件 → bootstrap 期 ERR_REQUIRE_ESM 拖垮全站），
 *     故所有依赖仅在请求内动态 import。
 *  2. 必须 @Body(ALL) 消费请求体，否则未读的 POST 流会让 FC 杀实例。
 *  3. 响应只能用「纯 return 值」交给 FaaS——ctx.status/type/body 或 respond=false+裸res
 *     都会让响应适配器 Process exited。故整体缓冲后 return 文本（首版不做真流式）。
 *  4. runtime/handler 不能跨请求缓存复用（模块级缓存会崩），每次请求内联新建。
 */
const ENDPOINT = '/copilotkit';

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
    try {
      const cp: any = await import('@copilotkit/runtime');
      const v2: any = await import('@copilotkit/runtime/v2');
      const ai: any = await import('@ai-sdk/openai');

      // DeepSeek（OpenAI 兼容）。必须 .chat() 强制 Chat Completions——
      // 默认 provider(model) 走 Responses API，DeepSeek 无该端点 → 404。
      const deepseek = ai.createOpenAI({
        apiKey: process.env.LLM_API_KEY,
        baseURL: 'https://api.deepseek.com',
      });
      const agent = new v2.BuiltInAgent({
        model: deepseek.chat(process.env.LLM_MODEL || 'deepseek-chat'),
      });
      const runtime = new cp.CopilotRuntime({ agents: { default: agent } });
      const handler = cp.copilotRuntimeNodeHttpEndpoint({ endpoint: ENDPOINT, runtime });

      // 只传 web Request、不传 res 时，handler 返回 honoApp.fetch(request) 的 web Response。
      const request = new Request(`http://fc.local${ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsedBody),
      });
      const response: any = await handler(request);
      return await response.text();
    } catch (err: any) {
      return JSON.stringify({ error: 'copilot_error', message: String(err?.message || err) });
    }
  }
}
