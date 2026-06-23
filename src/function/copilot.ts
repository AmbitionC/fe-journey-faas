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
    // 捕获 copilotkit 内部分离 promise 的 async 错误（否则 unhandledRejection 杀进程）
    let asyncErr: any = null;
    const onAsyncErr = (e: any) => {
      asyncErr = e;
    };
    process.on('unhandledRejection', onAsyncErr);
    process.on('uncaughtException', onAsyncErr);
    try {
      const handler = await getHandler();
      await handler(req, res);
      // CopilotKit 的 node-http handler 在 `pipe(res)` 后即 resolve，并不等待响应流写完。
      if (!res.writableEnded) {
        await new Promise<void>((resolve) => {
          res.on('finish', () => resolve());
          res.on('close', () => resolve());
          res.on('error', () => resolve());
        });
      }
    } catch (err: any) {
      handlerPromise = null;
      asyncErr = asyncErr || err;
    } finally {
      process.off('unhandledRejection', onAsyncErr);
      process.off('uncaughtException', onAsyncErr);
    }
    if (asyncErr && !res.writableEnded) {
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
        }
        res.end(
          JSON.stringify({
            error: 'copilot_error',
            message: String(asyncErr?.message || asyncErr),
            stack: String(asyncErr?.stack || '').split('\n').slice(0, 6).join(' | '),
          }),
        );
      } catch {
        /* ignore */
      }
    }
  }
}
