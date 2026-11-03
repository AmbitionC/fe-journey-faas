import { createHash, randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { McpRuntime } from './http';
import { Product, QueryFn } from './store';
import { SITES, isProduct } from './sites';
import { TIERS, TRIAL_POINTS, effectiveTier } from './billing';
import { track } from './analytics';

/**
 * MCP 的 OAuth 2.1 授权（owner 2026-11-03：「人家装 skill 都是一句话就行」）。
 *
 * 有了它，插件 / MCP 配置里不用再写 Key：客户端第一次连上收到 401 + WWW-Authenticate，
 * 按 MCP 授权规范自己发现授权服务器、动态注册、打开浏览器 → 用户在本站登录并点「授权」→
 * 客户端拿 code 换 token。我们发出的 token 就是一把普通的 jk_ Key（kind='oauth'），
 * 后面的鉴权、计费、日志完全走原来那一套，不用第二套 token 体系。
 *
 * 规范要点（2025-06-18）：
 * - 受保护资源元数据 RFC 9728：/.well-known/oauth-protected-resource/mcp/{product}
 * - 授权服务器元数据 RFC 8414：issuer = {base}/mcp/{product}，元数据在
 *   /.well-known/oauth-authorization-server/mcp/{product}（另给 OIDC 两种路径和根路径兜底）
 * - 动态客户端注册 RFC 7591：公共客户端，token_endpoint_auth_method=none
 * - 必须 PKCE S256；回环地址回调按 RFC 8252 不比端口
 *
 * 授权页在各自站点前端（Invest：/skills/authorize，Agent：/developer/authorize），
 * 前端用平台登录态调 POST /mcp/me/oauth/approve 拿回跳地址。
 */

/** 同一用户最多保留几把授权发出的 Key（每台电脑 / 每个客户端一把），超出吊销最旧的 */
export const MAX_OAUTH_KEYS = 5;
const CODE_TTL_MIN = 10;

/** 各站点的授权页路径 */
export const AUTHORIZE_PATH: Record<Product, string> = {
  agent: '/developer/authorize',
  invest: '/skills/authorize',
};

const SERVER_NAME: Record<Product, string> = {
  agent: 'agent-journey',
  invest: 'invest-journey',
};

export interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
}

export interface OAuthCode {
  client_id: string;
  user_id: string;
  product: Product;
  redirect_uri: string;
  code_challenge: string;
}

const sha256hex = (s: string) =>
  createHash('sha256').update(s, 'utf8').digest('hex');

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export class OAuthStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private q: QueryFn) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_oauth_client (
          client_id VARCHAR(64) PRIMARY KEY,
          client_name VARCHAR(128) NULL,
          redirect_uris TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) DEFAULT CHARSET=utf8mb4`);
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_oauth_code (
          code_hash CHAR(64) PRIMARY KEY,
          client_id VARCHAR(64) NOT NULL,
          user_id VARCHAR(64) NOT NULL,
          product VARCHAR(16) NOT NULL,
          redirect_uri VARCHAR(512) NOT NULL,
          code_challenge VARCHAR(128) NOT NULL,
          expires_at DATETIME NOT NULL,
          used_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_mcp_oauth_code_exp (expires_at)
        ) DEFAULT CHARSET=utf8mb4`);
      })().catch(e => {
        this.schemaReady = null;
        throw e;
      });
    }
    return this.schemaReady;
  }

  async registerClient(name: string | null, redirectUris: string[]) {
    await this.ensureSchema();
    const id = 'jc_' + randomBytes(16).toString('base64url');
    await this.q(
      'INSERT INTO mcp_oauth_client (client_id, client_name, redirect_uris) VALUES (?, ?, ?)',
      [id, name, JSON.stringify(redirectUris)]
    );
    return id;
  }

  async getClient(id: string): Promise<OAuthClient | null> {
    if (!id || id.length > 64) return null;
    await this.ensureSchema();
    const rows = await this.q(
      'SELECT client_id, client_name, redirect_uris FROM mcp_oauth_client WHERE client_id = ? LIMIT 1',
      [id]
    );
    const r = rows && rows[0];
    if (!r) return null;
    let uris: string[] = [];
    try {
      uris = JSON.parse(String(r.redirect_uris || '[]'));
    } catch {
      uris = [];
    }
    return {
      client_id: String(r.client_id),
      client_name: r.client_name ? String(r.client_name) : null,
      redirect_uris: Array.isArray(uris) ? uris.map(String) : [],
    };
  }

  async createCode(c: OAuthCode): Promise<string> {
    await this.ensureSchema();
    const code = 'jac_' + randomBytes(24).toString('base64url');
    await this.q(
      `INSERT INTO mcp_oauth_code (code_hash, client_id, user_id, product, redirect_uri, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MIN} MINUTE))`,
      [
        sha256hex(code),
        c.client_id,
        c.user_id,
        c.product,
        c.redirect_uri,
        c.code_challenge,
      ]
    );
    return code;
  }

  /** 一次性取用：已用过 / 过期 / 不存在都返回 null（并发换两次只有一次成功）。 */
  async consumeCode(code: string): Promise<OAuthCode | null> {
    if (!code || code.length > 100) return null;
    await this.ensureSchema();
    const h = sha256hex(code);
    const r = await this.q(
      'UPDATE mcp_oauth_code SET used_at = NOW() WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()',
      [h]
    );
    if (Number(r?.affectedRows ?? 0) !== 1) return null;
    const rows = await this.q(
      'SELECT client_id, user_id, product, redirect_uri, code_challenge FROM mcp_oauth_code WHERE code_hash = ? LIMIT 1',
      [h]
    );
    const x = rows && rows[0];
    if (!x || !isProduct(x.product)) return null;
    return {
      client_id: String(x.client_id),
      user_id: String(x.user_id),
      product: x.product,
      redirect_uri: String(x.redirect_uri),
      code_challenge: String(x.code_challenge),
    };
  }
}

// ---------------------------------------------------------------------------
// 纯函数：地址、校验

/** 对外根地址。FC 外网恒为 https；本机联调（localhost）用 http。 */
export function publicBase(headers: Record<string, any>): string {
  const env = process.env.MCP_PUBLIC_BASE;
  if (env) return env.replace(/\/+$/, '');
  const host = String(headers['x-forwarded-host'] || headers['host'] || '')
    .split(',')[0]
    .trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = local
    ? String(headers['x-forwarded-proto'] || 'http')
        .split(',')[0]
        .trim()
    : 'https';
  return `${proto}://${host}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const BAD_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
]);

/** 注册时允许的回调地址：https、回环 http、客户端自定义协议（如 cursor://）。 */
export function validRedirectUri(u: unknown): boolean {
  if (typeof u !== 'string' || !u || u.length > 500) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (BAD_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === 'https:') return !!url.hostname;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

export function isLoopback(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/** 授权请求里的回调地址必须是注册过的那几个之一；回环地址不比端口（RFC 8252 §7.3）。 */
export function redirectAllowed(
  client: OAuthClient,
  redirectUri: string
): boolean {
  if (!validRedirectUri(redirectUri)) return false;
  if (client.redirect_uris.includes(redirectUri)) return true;
  if (!isLoopback(redirectUri)) return false;
  const want = new URL(redirectUri);
  return client.redirect_uris.some(r => {
    if (!isLoopback(r)) return false;
    const u = new URL(r);
    return (
      u.hostname === want.hostname &&
      u.pathname === want.pathname &&
      u.search === want.search
    );
  });
}

export function withParams(base: string, params: Record<string, string>) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

/** 用户看得懂的客户端名与去向：授权页据此提醒「授权给谁、授权后回到哪」。 */
export function describeRedirect(u: string): string {
  try {
    const url = new URL(u);
    if (isLoopback(u)) return '你电脑上的客户端（本机回调）';
    if (url.protocol === 'https:') return url.host;
    return url.protocol.replace(/:$/, '') + ' 客户端';
  } catch {
    return '未知';
  }
}

/**
 * 授权页上显示的客户端名：Claude Code 注册时报的是「Claude Code (服务名)」，
 * 插件装的还会带 plugin:xx:xx，括号里的对用户没意义，只留前面的产品名。
 */
export function displayClientName(name: string | null): string {
  const n = (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return n || '你的客户端';
}

/** /mcp/agent、/mcp/invest → 产品；也认完整 URL（resource 参数）。 */
export function productFromResource(r: unknown): Product | null {
  if (typeof r !== 'string' || !r) return null;
  let p = r;
  try {
    p = new URL(r).pathname;
  } catch {
    // 不是完整 URL 就当路径
  }
  const m = /^\/mcp\/(agent|invest)\/?$/.exec(p);
  return m ? (m[1] as Product) : null;
}

export function resourceMetadataUrl(base: string, product: Product) {
  return `${base}/.well-known/oauth-protected-resource/mcp/${product}`;
}

/** 401 时给客户端的发现入口（RFC 9728 §5.1）。 */
export function wwwAuthenticate(
  base: string,
  product: Product,
  invalidToken = false
): string {
  return (
    `Bearer realm="${
      SERVER_NAME[product]
    }", resource_metadata="${resourceMetadataUrl(base, product)}"` +
    (invalidToken ? ', error="invalid_token"' : '')
  );
}

export function protectedResourceMetadata(base: string, product: Product) {
  return {
    resource: `${base}/mcp/${product}`,
    authorization_servers: [`${base}/mcp/${product}`],
    bearer_methods_supported: ['header'],
    resource_name: SITES[product].name,
    resource_documentation: SITES[product].manage,
  };
}

/** product 为空＝根路径兜底元数据：授权端点按 resource 参数判断产品。 */
export function authServerMetadata(base: string, product: Product | null) {
  return {
    issuer: product ? `${base}/mcp/${product}` : base,
    authorization_endpoint: product
      ? `${base}/mcp/oauth/${product}/authorize`
      : `${base}/mcp/oauth/authorize`,
    token_endpoint: `${base}/mcp/oauth/token`,
    registration_endpoint: `${base}/mcp/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    service_documentation: product ? SITES[product].manage : undefined,
  };
}

// ---------------------------------------------------------------------------
// HTTP

function sendJson(res: ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function oauthErr(
  res: ServerResponse,
  status: number,
  error: string,
  desc: string
) {
  return sendJson(res, status, { error, error_description: desc });
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[
        c
      ] as string)
  );

/** 回调地址不可信时不能跳回去（防开放跳转），直接给一页人话说明。 */
function errorPage(res: ServerResponse, status: number, msg: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权失败</title></head>' +
      '<body style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;color:#222;line-height:1.7">' +
      `<h2 style="margin:0 0 8px">授权没法继续</h2><p>${esc(
        msg
      )}</p><p style="color:#888">回到你的客户端重新发起连接即可（Claude Code 里输入 /mcp，选中服务后重新授权）。</p></body></html>`
  );
}

function redirect(res: ServerResponse, to: string) {
  res.statusCode = 302;
  res.setHeader('Location', to);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function parseBody(req: IncomingMessage, body: Buffer): Record<string, any> {
  const text = body.toString('utf8');
  const ct = String(req.headers['content-type'] || '');
  if (/json/i.test(ct)) {
    try {
      const v = JSON.parse(text || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** 授权请求里需要校验、需要往授权页透传的参数 */
interface AuthzParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  response_type: string;
}

function readAuthz(src: Record<string, any>): AuthzParams {
  return {
    client_id: str(src.client_id),
    redirect_uri: str(src.redirect_uri),
    state: str(src.state),
    code_challenge: str(src.code_challenge),
    code_challenge_method: str(src.code_challenge_method),
    scope: str(src.scope),
    response_type: str(src.response_type),
  };
}

interface Checked {
  ok: boolean;
  client?: OAuthClient;
  /** 回调地址都不可信：只能出错误页 */
  page?: string;
  /** 回调地址可信：按规范带 error 跳回客户端 */
  back?: string;
}

async function checkAuthz(rt: McpRuntime, p: AuthzParams): Promise<Checked> {
  if (!rt.oauth) return { ok: false, page: '授权服务暂未开放。' };
  if (!p.client_id)
    return { ok: false, page: '缺少 client_id，客户端发起的授权请求不完整。' };
  const client = await rt.oauth.getClient(p.client_id);
  if (!client)
    return {
      ok: false,
      page: '这个客户端没有注册过（或注册已失效），请让客户端重新发起连接。',
    };
  if (!p.redirect_uri || !redirectAllowed(client, p.redirect_uri))
    return { ok: false, page: '回调地址和客户端注册时的不一致，已拦下。' };
  const back = (error: string, desc: string) =>
    withParams(p.redirect_uri, {
      error,
      error_description: desc,
      state: p.state,
    });
  if (p.response_type !== 'code')
    return {
      ok: false,
      back: back('unsupported_response_type', 'only code is supported'),
    };
  if (!p.code_challenge || p.code_challenge_method !== 'S256')
    return {
      ok: false,
      back: back('invalid_request', 'PKCE with S256 is required'),
    };
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge))
    return {
      ok: false,
      back: back('invalid_request', 'malformed code_challenge'),
    };
  return { ok: true, client };
}

export function isOAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith('/.well-known/') ||
    pathname.startsWith('/mcp/oauth/') ||
    pathname.startsWith('/mcp/me/oauth/') ||
    /^\/mcp\/(agent|invest)\/\.well-known\//.test(pathname)
  );
}

export async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rt: McpRuntime,
  body: Buffer,
  method: string
): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '');
  const base = publicBase(req.headers as any);

  // ---- 发现 ----
  if (method === 'GET') {
    let m =
      /^\/\.well-known\/oauth-protected-resource\/mcp\/(agent|invest)$/.exec(
        path
      );
    if (m)
      return sendJson(
        res,
        200,
        protectedResourceMetadata(base, m[1] as Product)
      );
    m =
      /^\/\.well-known\/(?:oauth-authorization-server|openid-configuration)\/mcp\/(agent|invest)$/.exec(
        path
      ) ||
      /^\/mcp\/(agent|invest)\/\.well-known\/(?:oauth-authorization-server|openid-configuration)$/.exec(
        path
      );
    if (m) return sendJson(res, 200, authServerMetadata(base, m[1] as Product));
    if (
      path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/openid-configuration'
    )
      return sendJson(res, 200, authServerMetadata(base, null));
  }

  if (!rt.oauth) return oauthErr(res, 404, 'not_found', '授权服务暂未开放');

  // ---- 动态客户端注册 ----
  if (path === '/mcp/oauth/register' && method === 'POST') {
    const d = parseBody(req, body);
    const uris = Array.isArray(d.redirect_uris) ? d.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri))
      return oauthErr(
        res,
        400,
        'invalid_redirect_uri',
        'redirect_uris 必须是 https、回环 http 或客户端自定义协议地址'
      );
    const gt = Array.isArray(d.grant_types) ? d.grant_types : null;
    if (gt && !gt.includes('authorization_code'))
      return oauthErr(
        res,
        400,
        'invalid_client_metadata',
        'only authorization_code is supported'
      );
    const name =
      str(d.client_name)
        .replace(/[\p{Cc}]/gu, '')
        .trim()
        .slice(0, 80) || null;
    const id = await rt.oauth.registerClient(name, uris.map(String));
    await track(rt, {
      event: 'oauth_register',
      props: { clientName: name },
    });
    return sendJson(res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name || undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  // ---- 授权端点：校验后转到站点前端的授权页 ----
  const am = /^\/mcp\/oauth(?:\/(agent|invest))?\/authorize$/.exec(path);
  if (am && method === 'GET') {
    const params = Object.fromEntries(url.searchParams.entries());
    const product: Product | null =
      (am[1] as Product) || productFromResource(params.resource);
    if (!product)
      return errorPage(
        res,
        400,
        '没法判断要连接哪个服务（缺少 resource 参数），请升级客户端后重试。'
      );
    const p = readAuthz(params);
    const c = await checkAuthz(rt, p);
    if (!c.ok)
      return c.page ? errorPage(res, 400, c.page) : redirect(res, c.back!);
    await track(rt, {
      event: 'oauth_authorize',
      product,
      props: { clientName: c.client.client_name },
    });
    const site = SITES[product];
    return redirect(
      res,
      withParams(`${site.origin}${AUTHORIZE_PATH[product]}`, {
        client_id: p.client_id,
        redirect_uri: p.redirect_uri,
        state: p.state,
        code_challenge: p.code_challenge,
        code_challenge_method: p.code_challenge_method,
        scope: p.scope,
        response_type: p.response_type,
      })
    );
  }

  // ---- 授权页取客户端信息（公开）：显示「授权给谁」，以及拒绝时跳回哪 ----
  if (path === '/mcp/oauth/client' && method === 'GET') {
    const p = readAuthz(Object.fromEntries(url.searchParams.entries()));
    const c = await checkAuthz(rt, p);
    if (!c.ok)
      return sendJson(res, 400, {
        success: false,
        message: c.page || '客户端发起的授权请求参数不完整，请让客户端重新连接',
        back: c.back,
      });
    return sendJson(res, 200, {
      success: true,
      data: {
        clientName: displayClientName(c.client.client_name),
        redirectTo: describeRedirect(p.redirect_uri),
        local: isLoopback(p.redirect_uri),
        denyUrl: withParams(p.redirect_uri, {
          error: 'access_denied',
          error_description: 'user denied',
          state: p.state,
        }),
      },
    });
  }

  // ---- 用户点「授权」（平台登录态） ----
  if (path === '/mcp/me/oauth/approve' && method === 'POST') {
    const userId = await rt.userIdOf(req.headers as any).catch(() => null);
    if (!userId)
      return sendJson(res, 401, { success: false, message: '请先登录' });
    const d = parseBody(req, body);
    const product = isProduct(d.product) ? d.product : null;
    if (!product)
      return sendJson(res, 400, { success: false, message: '缺少产品参数' });
    const p = readAuthz(d);
    const c = await checkAuthz(rt, p);
    if (!c.ok)
      return sendJson(res, 400, {
        success: false,
        message: c.page || '授权请求参数不完整',
      });
    // 授权即开通：第一次来的用户直接送体验点，不用先去页面上点「开通」
    const { created } = await rt.billing.activate(userId);
    if (created) {
      await track(rt, {
        event: 'account_activated',
        userId,
        product,
        props: { created, via: 'oauth' },
      });
      await track(rt, {
        event: 'trial_granted',
        userId,
        product,
        props: { points: TRIAL_POINTS },
      });
    }
    const code = await rt.oauth.createCode({
      client_id: p.client_id,
      user_id: userId,
      product,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
    });
    await track(rt, {
      event: 'oauth_approved',
      userId,
      product,
      props: { clientName: c.client.client_name, newAccount: created },
    });
    return sendJson(res, 200, {
      success: true,
      data: {
        redirect: withParams(p.redirect_uri, { code, state: p.state }),
        newAccount: created,
        trialPoints: created ? TRIAL_POINTS : 0,
      },
    });
  }

  // ---- 换 token ----
  if (path === '/mcp/oauth/token' && method === 'POST') {
    const d = parseBody(req, body);
    if (str(d.grant_type) !== 'authorization_code')
      return oauthErr(
        res,
        400,
        'unsupported_grant_type',
        'only authorization_code is supported'
      );
    const code = await rt.oauth.consumeCode(str(d.code));
    if (!code)
      return oauthErr(res, 400, 'invalid_grant', '授权码无效、已用过或已过期');
    if (str(d.client_id) && str(d.client_id) !== code.client_id)
      return oauthErr(res, 400, 'invalid_grant', 'client_id 不匹配');
    if (str(d.redirect_uri) !== code.redirect_uri)
      return oauthErr(res, 400, 'invalid_grant', 'redirect_uri 不匹配');
    const verifier = str(d.code_verifier);
    if (
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      s256(verifier) !== code.code_challenge
    )
      return oauthErr(res, 400, 'invalid_grant', 'PKCE 校验失败');
    const client = await rt.oauth.getClient(code.client_id);
    const acct = await rt.billing.getAccount(code.user_id);
    const tier = effectiveTier(acct);
    const created = await rt.store.create({
      scope: code.product,
      owner: `user:${code.user_id}`,
      note: `${(client?.client_name || '客户端').slice(0, 40)} 授权`,
      dailyLimit: TIERS[tier].dailyLimit,
      userId: code.user_id,
      kind: 'oauth',
    });
    await rt.store.pruneOAuthKeys(code.user_id, MAX_OAUTH_KEYS).catch(() => 0);
    await track(rt, {
      event: 'key_created',
      userId: code.user_id,
      product: code.product,
      props: { tier, via: 'oauth', clientName: client?.client_name || null },
    });
    return sendJson(res, 200, {
      access_token: created.key,
      token_type: 'Bearer',
      scope: 'mcp',
    });
  }

  return oauthErr(res, 404, 'not_found', 'not found');
}
