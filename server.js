/**
 * FC 3.0 Web 函数入口：把整个 Midway faas 应用跑成一个 HTTP server。
 *
 * - 绝大多数路由走 Midway 框架（invokeTriggerFunction，按 path 分发，响应缓冲——够用）。
 * - 唯独 POST /api/ai/chat/stream 绕过框架：直接拿 AiProxyService.forwardStream，
 *   往真实 socket res.write 推 SSE，实现「真流式」（Midway 3.x 的 HTTPResponse 是缓冲的，
 *   框架内做不了流式，故此路单独直写）。
 * - /mcp/* 同样绕过框架：对外 MCP 数据服务（API Key 鉴权，见 src/mcp/http.ts）。
 */
const http = require('http');
const { join } = require('path');
// 辅助调用判定（与 src/function/ai.ts 共用；编译产物在 dist/common）
const { auxModuleFor, auxBucketFor } = require('./dist/common/aiPurpose');
// 可信客户端 IP（只认接入层追加的 XFF 最右段，见 src/common/clientIp.ts）
const { clientIpFromReq, describeClientIp } = require('./dist/common/clientIp');
// 客户端长文本裁剪（见 src/service/ai/irisGuard.ts）：必须在检索、落库之前做
const { clampMessages, clampTask } = require('./dist/service/ai/irisGuard');
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
let coachAgentService = null;
let mcpRuntimePromise = null;
let irisCreditService = null;
let entitlementService = null;
let irisErrorCode = () => null;

// MCP（/mcp/agent、/mcp/invest、/mcp/admin/*）：API Key 鉴权的对外数据服务，
// 不走 Midway（状态码语义与鉴权体系都不同），实现见 src/mcp/http.ts。
async function handleMcp(req, res, url) {
  const { handleMcpHttp, createMcpRuntime } = require('./dist/mcp/http');
  if (!mcpRuntimePromise) {
    mcpRuntimePromise = createMcpRuntime(appCtx).catch((e) => {
      mcpRuntimePromise = null;
      throw e;
    });
  }
  try {
    const rt = await mcpRuntimePromise;
    const body = ['POST', 'PUT', 'PATCH'].includes((req.method || '').toUpperCase())
      ? await readBody(req)
      : Buffer.alloc(0);
    await handleMcpHttp(req, res, url, rt, body);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP 服务内部错误' } }));
  }
}

// FC Web 入口统一补 CORS。普通路由也必须在这里处理：浏览器携带 token 等
// 自定义请求头时会先发 OPTIONS，而自定义 server.js 不会自动经过 Midway 的
// cross-domain 中间件；只依赖 config.default.ts 会导致 curl 正常、浏览器失败。
const CORS_ORIGINS = new Set([
  'https://www.agent-journey.cn',
  'https://agent-journey.cn',
  'https://fe-journey.cn',
  'https://invest-journey.cn',
  'https://www.invest-journey.cn',
  'http://localhost:8000',
  'http://localhost:8001',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:8001',
]);

// 追加额外域名（如 health-journey 前端的 Vercel 域名），逗号分隔，
// 经环境变量 EXTRA_CORS_ORIGINS 注入，不必改代码重发版。
for (const extra of (process.env.EXTRA_CORS_ORIGINS || '').split(',')) {
  const o = extra.trim();
  if (o) CORS_ORIGINS.add(o);
}

// health-journey 前端部署在 Vercel（*.vercel.app），域名随部署变化，按后缀放行。
function isAllowedOrigin(origin) {
  if (CORS_ORIGINS.has(origin)) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === 'https:' && hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin || isAllowedOrigin(origin);
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,Accept,token,X-Health-Token'
  );
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
        if (info && info.userId) {
          // 会员态决定 Iris 的每日上限与会员专享模式（与 src/function/ai.ts 的 getIsMember 同源：
          // 权益记录 / Skill 会员账户 / 限免期，都在 EntitlementService.isMember 里）
          let isMember = false;
          try {
            isMember = !!(entitlementService && (await entitlementService.isMember(info.userId)));
          } catch (e) {
            isMember = false;
          }
          return { userId: info.userId, isMember };
        }
      }
    } catch (e) {
      /* ignore */
    }
  }
  // 2026-11-04：不再取 XFF 第一个值（客户端可随意伪造，11-03 被刷 166 万 token）
  const ip = clientIpFromReq(req);
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

  // 先裁剪再用：检索（向量化）与会话落库都吃这份，原样用会把超长文本送去向量化、写进库
  const messages = clampMessages(body.messages || []);
  const context = body.context || {};

  // 取/建会话并落库用户消息（尽力而为）。
  // 界面自动发起的辅助调用（猜你想问）不是用户提的问题，不落库：
  // 否则会话列表里会多出一条「你是学习助手…」，Iris 还会把它当成「上次问过」。
  let conv = null;
  try {
    const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
    if (!auxModuleFor(body.purpose)) {
      conv = await aiHistoryService.ensureConversation(userId, body.conversationId, {
        module: context.module,
        articleKey: context.articleKey,
        firstUserText: lastUser && lastUser.content,
      });
    }
    if (conv && lastUser) {
      await aiHistoryService.appendMessage(conv, {
        role: 'user',
        content: lastUser.content,
      });
    }
  } catch (e) {
    /* 持久化失败不影响回答 */
  }

  // 深度思考：2026-11-02 起默认关闭（显式 true 才开；思考按 think 计点、普通按 chat）
  const deepThink = body.deepThink === true;

  // 结构化任务（算法提示/点评）：提示词服务端拼装，走 forwardTaskStream（PRD-02 F1-3）
  const task = body.task && body.task.kind ? clampTask(body.task) : null;

  // 辅助调用（前端「猜你想问」发 purpose:'suggest'）：不是用户提的问题。
  // ① 走独立限流桶，不吃用户自己的每日提问额度；
  // ② 计量上归到 module `aux:<purpose>`，让复盘能分开「用户在问」与「界面自动问」。
  // 判定与 src/function/ai.ts 共用 common/aiPurpose——**线上这条路由走的是本文件**，
  // 2026-09-20 只改了那边，测试与部署全绿而线上零变化，就是因为改在了不服务流量的一份上。
  const auxModule = auxModuleFor(body.purpose);

  // 用户自己提的普通问题走 Iris 教练工具循环（CoachAgentService：自主检索 / 读原文 / 追问，带引用与 status 帧）；
  // 结构化任务（算法提示/点评）和辅助调用仍走单轮流式。
  // 2026-11-10 发现：此前工具循环只接在 src/function/ai.ts 那份（不服务流量），线上 Iris 一直是单轮 RAG。
  const useAgent =
    !task &&
    !auxModule &&
    !!coachAgentService &&
    process.env.COACH_AGENTIC_ENABLED === 'true' &&
    aiProxyService.supportsTools();

  // RAG：用最后一条用户消息召回站内资料，注入上下文 + 先下发引用帧（PRD-02 F1-1/F1-2）
  // 工具循环自己检索并在结尾下发引用，不走这一步。
  let citations = [];
  try {
    const lastUserMsg = [...messages].reverse().find((m) => m && m.role === 'user');
    if (!useAgent && !task && lastUserMsg && lastUserMsg.content && retrieveService) {
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

  if (auxModule) context.module = auxModule;

  let full = '';
  // 计点（IrisCreditService）：辅助调用不扣点只限流；用户提问按 chat / think 扣点；
  // 上游失败或一字未出退点。错误帧带 code（RATE_LIMIT / CREDIT_EXHAUSTED / MEMBER_ONLY），前端按 code 分流。
  let charge = null;
  try {
    const auxBucket = auxBucketFor(body.purpose);
    if (auxBucket || !irisCreditService) {
      await aiProxyService.checkRateLimit(userId, isMember, auxBucket);
    } else {
      charge = await irisCreditService.begin(userId, isMember, deepThink ? 'think' : 'chat');
    }
    if (useAgent) {
      // 带上本会话 id：跨会话记忆要排除它（否则「上次你问过」会把这次的问题本身算进去）
      if (conv && conv.id) context.conversationId = conv.id;
      for await (const frame of coachAgentService.streamAgentic(messages, context, userId)) {
        if (frame.status) res.write(`data: ${JSON.stringify({ status: frame.status })}\n\n`);
        if (frame.content) {
          full += frame.content;
          res.write(`data: ${JSON.stringify({ content: frame.content })}\n\n`);
        }
        if (frame.question) {
          // 追问也算产出（不退点），并以文字落进会话历史，下一轮模型能看到自己问了什么
          const q = frame.question;
          const opts = Array.isArray(q.options) && q.options.length ? '\n\n' + q.options.map((o) => `- ${o}`).join('\n') : '';
          full += `${q.question}${opts}`;
          res.write(`data: ${JSON.stringify({ question: q })}\n\n`);
        }
        if (frame.citations) res.write(`data: ${JSON.stringify({ citations: frame.citations })}\n\n`);
        if (frame.error) {
          // 一字未出才按失败处理（退点 + 错误帧）；已经答了一部分就只补一条错误帧
          if (!full) throw new Error(frame.error);
          res.write(`data: ${JSON.stringify({ error: frame.error, code: irisErrorCode(frame.error) })}\n\n`);
        }
      }
    }
    const gen = useAgent
      ? []
      : task
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
    if (charge) await charge.refund().catch(() => {});
    charge = null;
    res.write(
      `data: ${JSON.stringify({
        error: (err && err.message) || 'AI 请求失败',
        code: irisErrorCode(err && err.message),
      })}\n\n`
    );
  } finally {
    if (charge && !full) await charge.refund().catch(() => {});
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
  try {
    const { CoachAgentService } = require('./dist/service/ai/coachAgent');
    coachAgentService = await appCtx.getAsync(CoachAgentService);
  } catch (e) {
    console.error('[server] CoachAgentService unavailable, Iris falls back to single-shot answers', e && e.message);
  }
  try {
    const irisCredit = require('./dist/service/ai/irisCredit');
    irisCreditService = await appCtx.getAsync(irisCredit.IrisCreditService);
    irisErrorCode = irisCredit.irisErrorCode;
  } catch (e) {
    console.error('[server] IrisCreditService unavailable, falling back to rate limit', e && e.message);
  }
  try {
    const { EntitlementService } = require('./dist/service/entitlement');
    entitlementService = await appCtx.getAsync(EntitlementService);
  } catch (e) {
    console.error('[server] EntitlementService unavailable', e && e.message);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error('[server] request failed', req.method, req.url && req.url.split('?')[0], err && err.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      try {
        res.end(JSON.stringify({ success: false, message: '服务内部错误' }));
      } catch (e) {
        /* ignore */
      }
    });
  });

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // /copilotkit 已下线（@copilotkit/runtime 与 dist/copilot 早已不在包里）：2026-11-04 前访问它会在
    // require 处抛错、变成未处理的 Promise 拒绝，直接把整个实例打崩（一个请求就能让所有在途请求 502）。
    if (url.pathname === '/copilotkit') {
      setCors(req, res);
      res.statusCode = 410;
      return res.end();
    }
    // 自查可信客户端 IP：只回显调用方自己发来的 XFF 链与服务端认定的 IP（见 src/common/clientIp.ts）
    if (url.pathname === '/api/ai/whoami') {
      setCors(req, res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(
        JSON.stringify(describeClientIp(req.headers['x-forwarded-for'], req.socket && req.socket.remoteAddress))
      );
    }
    // /.well-known/oauth-*：MCP 授权发现（一句话安装，客户端自己走浏览器授权），实现见 src/mcp/oauth.ts
    if (url.pathname.startsWith('/mcp/') || url.pathname.startsWith('/.well-known/oauth-') || url.pathname.startsWith('/.well-known/openid-configuration'))
      return handleMcp(req, res, url);
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
  }

  server.listen(PORT, () => {
    console.log(`[server] FC3 web function listening on :${PORT}`);
  });
}

// 兜底：任何漏网的异步错误只记日志，不让进程退出（Node 15+ 默认未处理拒绝即退出，会打断所有在途请求）
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection', err && (err.stack || err.message || err));
});

bootstrap().catch((err) => {
  console.error('[server] bootstrap failed', err);
  process.exit(1);
});
