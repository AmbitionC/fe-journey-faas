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
let redisService;

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

// 真流式：SSE 直写
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
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  try {
    await aiProxyService.checkRateLimit(userId, isMember);
    const gen = aiProxyService.forwardStream(
      body.messages || [],
      body.context || {},
      userId
    );
    for await (const chunk of gen) {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }
  } catch (err) {
    res.write(
      `data: ${JSON.stringify({ error: (err && err.message) || 'AI 请求失败' })}\n\n`
    );
  } finally {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// 其余路由走 Midway 框架（缓冲响应）
async function handleFramework(req, res, url) {
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
    res.statusCode = statusCode || 200;
    if (isBase64Encoded && typeof body === 'string') {
      res.end(Buffer.from(body, 'base64'));
    } else {
      res.end(body);
    }
  } catch (err) {
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
  const { RedisService } = require('@midwayjs/redis');
  aiProxyService = await appCtx.getAsync(AiProxyService);
  redisService = await appCtx.getAsync(RedisService);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/ai/chat/stream' && (req.method || '').toUpperCase() === 'POST') {
      return handleStream(req, res);
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
