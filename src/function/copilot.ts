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
    // 绕过 Midway/Koa 的响应序列化，自己把 web Response 泵到 ctx.res。
    // @Body(ALL) 必需：触发 Midway 消费请求体——否则未读的 POST 流会让 FC 杀实例。
    (this.ctx as any).respond = false;
    const res: any = this.ctx.res;
    const reqUrl: string = this.ctx.req?.url || '/copilotkit';
    const parsedBody = body ?? {};

    // 临时分阶段诊断：body.method==='_diag' & stage A..E，定位崩溃发生在哪一步
    if (parsedBody && parsedBody.method === '_diag') {
      const stage = String(parsedBody.stage || 'A');
      const done = (o: any) => {
        try {
          // 用 ctx.set（Koa）设头，与可用的 aiChatStream 同款，避免裸 res.setHeader
          this.ctx.set('Content-Type', 'application/json');
          res.end(JSON.stringify(o));
        } catch {
          /* ignore */
        }
      };
      try {
        if (stage === 'A') return done({ ok: 'A' });
        const cp: any = await import('@copilotkit/runtime');
        if (stage === 'B') return done({ ok: 'B', keys: Object.keys(cp).slice(0, 6) });
        const v2: any = await import('@copilotkit/runtime/v2');
        const ai: any = await import('@ai-sdk/openai');
        if (stage === 'C')
          return done({ ok: 'C', hasBuiltIn: !!v2.BuiltInAgent, hasCreate: !!ai.createOpenAI });
        const deepseek = ai.createOpenAI({
          apiKey: process.env.LLM_API_KEY,
          baseURL: 'https://api.deepseek.com',
        });
        const agent = new v2.BuiltInAgent({
          model: deepseek.chat(process.env.LLM_MODEL || 'deepseek-chat'),
        });
        const runtime = new cp.CopilotRuntime({ agents: { default: agent } });
        if (stage === 'D') return done({ ok: 'D' });
        const handler = cp.copilotRuntimeNodeHttpEndpoint({ endpoint: ENDPOINT, runtime });
        const request = new Request('http://fc.local/copilotkit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'info', params: {}, body: {} }),
        });
        const response = await handler(request);
        const text = await response.text();
        return done({ ok: 'E', status: response.status, body: text.slice(0, 300) });
      } catch (e: any) {
        return done({
          diagError: String(e?.message || e),
          stack: String(e?.stack || '').split('\n').slice(0, 8).join(' | '),
        });
      }
    }
    try {
      // handler 只传 web Request、不传 res 时，返回 honoApp.fetch(request) 的 web Response。
      // 不走 copilotkit 自带的 res.pipe（其 handler 提前 resolve 且在 FC 上会让进程异常退出），
      // 改为手动读取 Response 流并写入 ctx.res——与已验证可用的 aiChatStream 同款写法。
      const handler = await getHandler();
      const request = new Request(`http://fc.local${reqUrl}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsedBody),
      });
      const response: any = await (handler as any)(request);

      this.ctx.status = response.status || 200;
      response.headers.forEach((v: string, k: string) => {
        try {
          this.ctx.set(k, v);
        } catch {
          /* 个别 hop-by-hop 头不可设，忽略 */
        }
      });
      this.ctx.set('X-Accel-Buffering', 'no');

      const body = response.body;
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
      } else if (body) {
        res.write(Buffer.from(await response.text()));
      }
      res.end();
    } catch (err: any) {
      handlerPromise = null; // 失败不缓存，下次重试
      try {
        if (!res.headersSent) {
          this.ctx.status = 500;
          this.ctx.set('Content-Type', 'application/json');
        }
        res.end(
          JSON.stringify({
            error: 'copilot_error',
            message: String(err?.message || err),
            stack: String(err?.stack || '').split('\n').slice(0, 8).join(' | '),
          }),
        );
      } catch {
        /* ignore */
      }
    }
  }
}
