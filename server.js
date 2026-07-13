/**
 * FC 3.0 Web 函数入口：把整个 Midway faas 应用跑成一个 HTTP server。
 *
 * - 绝大多数路由走 Midway 框架（invokeTriggerFunction，按 path 分发，响应缓冲——够用）。
 * - 唯独 POST /api/ai/chat/stream 绕过框架：直接拿 AiProxyService.forwardStream，
 *   往真实 socket res.write 推 SSE，实现「真流式」（Midway 3.x 的 HTTPResponse 是缓冲的，
 *   框架内做不了流式，故此路单独直写）。
 */
const http = require('http');
const { join } = require('path');
const { BootstrapStarter } = require('@midwayjs/fc-starter');
const core = require('@midwayjs/core');

const PORT = process.env.FC_SERVER_PORT || process.env.PORT || 9000;

let framework;
let appCtx;
let aiProxyService;
let aiHistoryService;
let redisService;
let articleService;
let retrieveService;

// FC Web 入口统一补 CORS。普通路由也必须在这里处理：浏览器携带 token 等
// 自定义请求头时会先发 OPTIONS，而自定义 server.js 不会自动经过 Midway 的
// cross-domain 中间件；只依赖 config.default.ts 会导致 curl 正常、浏览器失败。
const CORS_ORIGINS = new Set([
  'https://fe-journey.cn',
  'https://invest-journey.cn',
  'https://www.invest-journey.cn',
  'http://localhost:8000',
  'http://localhost:8001',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:8001',
]);

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin || CORS_ORIGINS.has(origin);
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,token');
  res.setHeader('Access-Control-Max-Age', '86400');
  return allowed;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

async function resolveUser(req) {
  const token =
    req.headers.token ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (token && redisService) {
    try {
      const infoStr = await redisService.get(`token:${token}`);
      if (infoStr) {
        const info = JSON.parse(infoStr);
        if (info && info.userId) return { userId: info.userId, isMember: false };
      }
    } catch (e) {
      /* ignore */
    }
  }
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    (fwd ? String(fwd).split(',')[0].trim() : '') ||
    (req.socket && req.socket.remoteAddress) ||
    'anonymous';
  return { userId: `guest:${ip}`, isMember: false };
}

// 真流式：SSE 直写 + 会话持久化
async function handleStream(req, res) {
  const raw = (await readBody(req)).toString('utf8');
  let body = {};
  try {
    body = JSON.parse(raw || '{}');
  } catch (e) {
    /* ignore */
  }

  const { userId, isMember } = await resolveUser(req);

  res.statusCode = 200;
  setCors(req, res);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const messages = body.messages || [];
  const context = body.context || {};

  // 取/建会话并落库用户消息（尽力而为）
  let conv = null;
  try {
    const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
    conv = await aiHistoryService.ensureConversation(userId, body.conversationId, {
      module: context.module,
      articleKey: context.articleKey,
      firstUserText: lastUser && lastUser.content,
    });
    if (lastUser) {
      await aiHistoryService.appendMessage(conv, {
        role: 'user',
        content: lastUser.content,
      });
    }
  } catch (e) {
    /* 持久化失败不影响回答 */
  }

  // 深度思考：默认开启（前端开关；缺省也视为开）
  const deepThink = body.deepThink !== false;

  // 结构化任务（算法提示/点评）：提示词服务端拼装，走 forwardTaskStream（PRD-02 F1-3）
  const task = body.task && body.task.kind ? body.task : null;

  // RAG：用最后一条用户消息召回站内资料，注入上下文 + 先下发引用帧（PRD-02 F1-1/F1-2）
  let citations = [];
  try {
    const lastUserMsg = [...messages].reverse().find((m) => m && m.role === 'user');
    if (!task && lastUserMsg && lastUserMsg.content && retrieveService) {
      const hits = await retrieveService.retrieve(lastUserMsg.content, {
        module: context.module,
        topK: 3,
      });
      if (hits && hits.length) {
        citations = hits.map((h) => ({ title: h.title, articleKey: h.articleKey, module: h.module }));
        context.ragContext = hits
          .map((h, i) => `[${i + 1}] 《${h.title}》(articleKey=${h.articleKey}, module=${h.module})`)
          .join('\n');
        res.write(`data: ${JSON.stringify({ citations })}\n\n`);
      }
    }
  } catch (e) {
    /* 检索失败不影响回答 */
  }

  let full = '';
  try {
    await aiProxyService.checkRateLimit(userId, isMember);
    const gen = task
      ? aiProxyService.forwardTaskStream(task, userId, deepThink)
      : aiProxyService.forwardStream(messages, context, userId, deepThink);
    for await (const chunk of gen) {
      if (chunk && chunk.reasoning) {
        res.write(`data: ${JSON.stringify({ reasoning: chunk.reasoning })}\n\n`);
      }
      if (chunk && chunk.content) {
        full += chunk.content;
        res.write(`data: ${JSON.stringify({ content: chunk.content })}\n\n`);
      }
    }
  } catch (err) {
    res.write(
      `data: ${JSON.stringify({ error: (err && err.message) || 'AI 请求失败' })}\n\n`
    );
  } finally {
    // 落库助手回复 + 回传 conversationId
    if (conv && full) {
      try {
        await aiHistoryService.appendMessage(conv, {
          role: 'assistant',
          content: full,
        });
      } catch (e) {
        /* ignore */
      }
    }
    if (conv) {
      res.write(`data: ${JSON.stringify({ conversationId: conv.id })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// 其余路由走 Midway 框架（缓冲响应）
async function handleFramework(req, res, url) {
  const corsAllowed = setCors(req, res);
  if ((req.method || '').toUpperCase() === 'OPTIONS') {
    res.statusCode = corsAllowed ? 204 : 403;
    return res.end();
  }

  try {
    const method = (req.method || 'GET').toLowerCase();
    if (['post', 'put', 'delete', 'patch'].includes(method)) {
      req.body = await readBody(req);
    }
    req.query = Object.fromEntries(url.searchParams);
    req.path = url.pathname;

    const ctx = await framework.wrapHttpRequest(req);
    const result = await framework.invokeTriggerFunction(ctx, url.pathname, {
      isHttpFunction: true,
    });
    const { statusCode, headers, body, isBase64Encoded } = result;
    if (res.headersSent) return;
    for (const key in headers || {}) res.setHeader(key, headers[key]);
    // 框架响应头可能覆盖入口层设置；以入口白名单重新落一次最终值。
    setCors(req, res);
    res.statusCode = statusCode || 200;
    if (isBase64Encoded && typeof body === 'string') {
      res.end(Buffer.from(body, 'base64'));
    } else {
      res.end(body);
    }
  } catch (err) {
    setCors(req, res);
    if (!res.headersSent) res.statusCode = (err && err.status) || 500;
    res.end((err && err.message) || 'Internal Server Error');
  }
}

async function bootstrap() {
  const starter = new BootstrapStarter();
  const exp = starter.start({
    appDir: __dirname,
    baseDir: join(__dirname, 'dist'),
    initializeMethodName: 'initializer',
  });
  await exp.initializer();

  appCtx = starter.getApplicationContext();
  const frameworkService = appCtx.get(core.MidwayFrameworkService);
  framework = frameworkService.getMainFramework();

  // 取流式所需的服务实例（单例，注入已解析）
  const { AiProxyService } = require('./dist/service/ai/proxy');
  const { AiHistoryService } = require('./dist/service/ai/history');
  const { RedisService } = require('@midwayjs/redis');
  aiProxyService = await appCtx.getAsync(AiProxyService);
  aiHistoryService = await appCtx.getAsync(AiHistoryService);
  redisService = await appCtx.getAsync(RedisService);
  const { ArticleService } = require('./dist/service/article');
  articleService = await appCtx.getAsync(ArticleService);
  const { RetrieveService } = require('./dist/service/ai/retrieve');
  retrieveService = await appCtx.getAsync(RetrieveService);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/copilotkit') {
      const { CopilotRuntime, copilotRuntimeNodeHttpEndpoint } = require('@copilotkit/runtime');
      const { makeServiceAdapter } = require('./dist/copilot/deepseekAdapter');
      setCors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const { userId, isMember } = await resolveUser(req);
      // 共用限流：游客按 IP 限额（与 SSE 链路一致）；超限直接 429
      try {
        await aiProxyService.checkRateLimit(userId, isMember);
      } catch (e) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: (e && e.message) || 'RATE_LIMIT' }));
        return;
      }
      const actions = [
        {
          name: 'getLearnerProfile',
          description: '查询当前用户在某模块的学情画像(覆盖度/最近/待复习)',
          parameters: [
            { name: 'module', type: 'string', description: '模块如 knowledge/interview', required: true },
          ],
          handler: async ({ module }) => await articleService.getLearnerProfile(userId, module),
        },
        {
          name: 'listReviewDue',
          description: '列出当前用户某模块建议复习的文章 key',
          parameters: [
            { name: 'module', type: 'string', description: '模块如 knowledge/interview', required: true },
          ],
          handler: async ({ module }) => {
            const p = await articleService.getLearnerProfile(userId, module);
            return { reviewDue: p.reviewDue };
          },
        },
        {
          name: 'searchKnowledge',
          description:
            '在站内知识库检索与问题相关的文章。回答站内技术问题前应先调用它，并据返回结果作答、在末尾用「延伸阅读」列出引用文章（标题可点击跳转）。不要编造不在结果里的文章。',
          parameters: [
            { name: 'query', type: 'string', description: '检索关键词或问题', required: true },
            { name: 'module', type: 'string', description: '可选，限定模块 knowledge/interview/firstclass', required: false },
          ],
          handler: async ({ query, module }) => {
            const items = await retrieveService.retrieve(query, { module, topK: 3 });
            return { items };
          },
        },
      ];
      const runtime = new CopilotRuntime({ actions });
      const handler = copilotRuntimeNodeHttpEndpoint({
        endpoint: '/copilotkit', runtime, serviceAdapter: makeServiceAdapter(),
      });
      return handler(req, res);
    }
    if (url.pathname === '/api/ai/chat/stream') {
      const m = (req.method || '').toUpperCase();
      if (m === 'OPTIONS') {
        setCors(req, res);
        res.statusCode = 204;
        return res.end();
      }
      if (m === 'POST') return handleStream(req, res);
    }
    return handleFramework(req, res, url);
  });

  server.listen(PORT, () => {
    console.log(`[server] FC3 web function listening on :${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[server] bootstrap failed', err);
  process.exit(1);
});
