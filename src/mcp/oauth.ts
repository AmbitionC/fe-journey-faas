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

/**
 * 设备授权（RFC 8628，owner 2026-11-03 对照可灵：装 Skill → 命令行 login → 浏览器点授权）。
 * 命令行拿 device_code 轮询；用户在站点授权页看到同一个 user_code，登录后点授权。
 * 不需要回调地址，所以 Claude App / Cowork / 远程机器 / 沙箱里都能用。
 */
export const DEVICE_TTL_SEC = 600;
export const DEVICE_INTERVAL_SEC = 3;
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** user_code 字母表：去掉元音和易混字母，避免拼出词、避免 0/O、1/I 混淆（RFC 8628 §6.1） */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface OAuthDevice {
  user_code: string;
  product: Product;
  client_name: string | null;
  status: DeviceStatus;
  user_id: string | null;
  expired: boolean;
}

export function newUserCode(): string {
  const b = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++)
    out += USER_CODE_ALPHABET[b[i] % USER_CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** 用户手输 / 地址栏带来的 user_code 规整成 XXXX-XXXX；不合法返回空串 */
export function normalizeUserCode(raw: unknown): string {
  const t = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (t.length !== 8) return '';
  for (const ch of t) if (!USER_CODE_ALPHABET.includes(ch)) return '';
  return `${t.slice(0, 4)}-${t.slice(4)}`;
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
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_oauth_device (
          device_hash CHAR(64) PRIMARY KEY,
          user_code CHAR(9) NOT NULL,
          product VARCHAR(16) NOT NULL,
          client_name VARCHAR(128) NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          user_id VARCHAR(64) NULL,
          expires_at DATETIME NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_mcp_oauth_device_code (user_code),
          KEY idx_mcp_oauth_device_exp (expires_at)
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

  async createDevice(
    product: Product,
    clientName: string | null
  ): Promise<{ device_code: string; user_code: string }> {
    await this.ensureSchema();
    // 过期很久的顺手清掉，user_code 唯一键不会越攒越满
    await this.q(
      'DELETE FROM mcp_oauth_device WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'
    ).catch(() => null);
    for (let i = 0; ; i++) {
      const device_code = 'jdc_' + randomBytes(24).toString('base64url');
      const user_code = newUserCode();
      try {
        await this.q(
          `INSERT INTO mcp_oauth_device (device_hash, user_code, product, client_name, expires_at)
           VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${DEVICE_TTL_SEC} SECOND))`,
          [sha256hex(device_code), user_code, product, clientName]
        );
        return { device_code, user_code };
      } catch (e: any) {
        if (i >= 3 || !/Duplicate/i.test(String(e?.message || e))) throw e;
      }
    }
  }

  private rowToDevice(x: any): OAuthDevice | null {
    if (!x || !isProduct(x.product)) return null;
    return {
      user_code: String(x.user_code),
      product: x.product,
      client_name: x.client_name ? String(x.client_name) : null,
      status: String(x.status) as DeviceStatus,
      user_id: x.user_id ? String(x.user_id) : null,
      expired: Number(x.expired) === 1,
    };
  }

  async getDeviceByUserCode(userCode: string): Promise<OAuthDevice | null> {
    if (!userCode) return null;
    await this.ensureSchema();
    const rows = await this.q(
      `SELECT user_code, product, client_name, status, user_id,
              (expires_at <= NOW()) AS expired
         FROM mcp_oauth_device WHERE user_code = ? LIMIT 1`,
      [userCode]
    );
    return this.rowToDevice(rows && rows[0]);
  }

  /** 用户在授权页点「授权 / 拒绝」：只改仍在等待、未过期的那条 */
  async decideDevice(
    userCode: string,
    userId: string,
    approve: boolean
  ): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.q(
      `UPDATE mcp_oauth_device SET status = ?, user_id = ?
        WHERE user_code = ? AND status = 'pending' AND expires_at > NOW()`,
      [approve ? 'approved' : 'denied', userId, userCode]
    );
    return Number(r?.affectedRows ?? 0) === 1;
  }

  /**
   * 命令行轮询。已授权的那次原子地改成 consumed 再返回（并发轮询只有一次拿到 Key）。
   */
  async pollDevice(deviceCode: string): Promise<OAuthDevice | null> {
    if (!deviceCode || deviceCode.length > 100) return null;
    await this.ensureSchema();
    const h = sha256hex(deviceCode);
    const rows = await this.q(
      `SELECT user_code, product, client_name, status, user_id,
              (expires_at <= NOW()) AS expired
         FROM mcp_oauth_device WHERE device_hash = ? LIMIT 1`,
      [h]
    );
    const d = this.rowToDevice(rows && rows[0]);
    if (!d || d.status !== 'approved') return d;
    const r = await this.q(
      "UPDATE mcp_oauth_device SET status = 'consumed' WHERE device_hash = ? AND status = 'approved'",
      [h]
    );
    return Number(r?.affectedRows ?? 0) === 1
      ? d
      : { ...d, status: 'consumed' };
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
    // 带产品时直接给站点前端的授权页：函数计算默认域名不允许 302 跳到外站
    // （ExternalRedirectForbidden），绕一道后端跳转在线上走不通
    authorization_endpoint: product
      ? `${SITES[product].origin}${AUTHORIZE_PATH[product]}`
      : `${base}/mcp/oauth/authorize`,
    token_endpoint: `${base}/mcp/oauth/token`,
    registration_endpoint: `${base}/mcp/oauth/register`,
    device_authorization_endpoint: product
      ? `${base}/mcp/oauth/${product}/device`
      : undefined,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', DEVICE_GRANT],
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

/**
 * 跳转用 200 + 页面内跳转，不用 302：函数计算默认域名（*.fcapp.run）会把指向外站的
 * Location 拦成 ExternalRedirectForbidden，客户端回调（localhost）和站点授权页都算外站。
 */
function redirect(res: ServerResponse, to: string) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const href = esc(to);
  res.end(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      `<meta http-equiv="refresh" content="0;url=${href}">` +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>正在跳转</title></head>' +
      '<body style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;color:#222;line-height:1.7">' +
      `<p>正在跳转… 没有自动跳转请 <a href="${href}">点这里</a>。</p>` +
      `<script>location.replace(${JSON.stringify(to).replace(/</g, '\\u003c')})</script></body></html>`
  );
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
    // 客户端直接打开站点授权页（不经后端跳转），在这里记「发起授权」
    const qp = url.searchParams.get('product');
    await track(rt, {
      event: 'oauth_authorize',
      product: isProduct(qp) ? qp : productFromResource(url.searchParams.get('resource')),
      props: { clientName: c.client.client_name },
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

  // ---- 设备授权：命令行发起 ----
  const dm = /^\/mcp\/oauth(?:\/(agent|invest))?\/device$/.exec(path);
  if (dm && method === 'POST') {
    const d = parseBody(req, body);
    const product: Product | null =
      (dm[1] as Product) || (isProduct(d.product) ? d.product : null);
    if (!product)
      return oauthErr(res, 400, 'invalid_request', '缺少产品参数');
    const name =
      str(d.client_name)
        .replace(/[\p{Cc}]/gu, '')
        .trim()
        .slice(0, 80) || null;
    const { device_code, user_code } = await rt.oauth.createDevice(
      product,
      name
    );
    const page = `${SITES[product].origin}${AUTHORIZE_PATH[product]}`;
    await track(rt, {
      event: 'oauth_authorize',
      product,
      props: { clientName: name, via: 'device' },
    });
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, {
      device_code,
      user_code,
      verification_uri: page,
      verification_uri_complete: withParams(page, { user_code }),
      expires_in: DEVICE_TTL_SEC,
      interval: DEVICE_INTERVAL_SEC,
    });
  }

  // ---- 设备授权：授权页取信息（公开，只回显用户自己看得到的东西） ----
  if (path === '/mcp/oauth/device/info' && method === 'GET') {
    const code = normalizeUserCode(url.searchParams.get('user_code'));
    const dv = code ? await rt.oauth.getDeviceByUserCode(code) : null;
    if (!dv)
      return sendJson(res, 404, {
        success: false,
        message: '没有找到这个授权码，请回到 Agent 重新发起登录。',
      });
    return sendJson(res, 200, {
      success: true,
      data: {
        userCode: dv.user_code,
        product: dv.product,
        clientName: displayClientName(dv.client_name),
        status: dv.expired && dv.status === 'pending' ? 'expired' : dv.status,
      },
    });
  }

  // ---- 设备授权：用户点「授权 / 取消」 ----
  if (path === '/mcp/me/oauth/device/approve' && method === 'POST') {
    const userId = await rt.userIdOf(req.headers as any).catch(() => null);
    if (!userId)
      return sendJson(res, 401, { success: false, message: '请先登录' });
    const d = parseBody(req, body);
    const code = normalizeUserCode(d.user_code);
    const dv = code ? await rt.oauth.getDeviceByUserCode(code) : null;
    if (!dv || (isProduct(d.product) && d.product !== dv.product))
      return sendJson(res, 404, {
        success: false,
        message: '没有找到这个授权码，请回到 Agent 重新发起登录。',
      });
    const approve = d.deny !== true && d.deny !== 'true';
    if (dv.expired || dv.status !== 'pending' ||
        !(await rt.oauth.decideDevice(code, userId, approve)))
      return sendJson(res, 409, {
        success: false,
        message:
          dv.status === 'pending'
            ? '这个授权码已过期，请回到 Agent 重新发起登录。'
            : '这个授权码已经处理过了，回到 Agent 继续即可。',
      });
    if (!approve) return sendJson(res, 200, { success: true, data: {} });
    const { created } = await rt.billing.activate(userId);
    if (created) {
      await track(rt, {
        event: 'account_activated',
        userId,
        product: dv.product,
        props: { created, via: 'device' },
      });
      await track(rt, {
        event: 'trial_granted',
        userId,
        product: dv.product,
        props: { points: TRIAL_POINTS },
      });
    }
    await track(rt, {
      event: 'oauth_approved',
      userId,
      product: dv.product,
      props: { clientName: dv.client_name, newAccount: created, via: 'device' },
    });
    return sendJson(res, 200, {
      success: true,
      data: { newAccount: created, trialPoints: created ? TRIAL_POINTS : 0 },
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
    if (str(d.grant_type) === DEVICE_GRANT) {
      const dv = await rt.oauth.pollDevice(str(d.device_code));
      if (!dv) return oauthErr(res, 400, 'invalid_grant', 'device_code 无效');
      if (dv.status === 'denied')
        return oauthErr(res, 400, 'access_denied', '用户取消了授权');
      if (dv.status === 'consumed')
        return oauthErr(res, 400, 'invalid_grant', '这个授权已经用过了');
      if (dv.status === 'pending')
        return dv.expired
          ? oauthErr(res, 400, 'expired_token', '授权码已过期，请重新登录')
          : oauthErr(res, 400, 'authorization_pending', '等待用户在浏览器里授权');
      const key = await issueOAuthKey(
        rt,
        dv.user_id!,
        dv.product,
        dv.client_name
      );
      return sendJson(res, 200, {
        access_token: key,
        token_type: 'Bearer',
        scope: 'mcp',
        product: dv.product,
      });
    }
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
    const key = await issueOAuthKey(
      rt,
      code.user_id,
      code.product,
      client?.client_name || null
    );
    return sendJson(res, 200, {
      access_token: key,
      token_type: 'Bearer',
      scope: 'mcp',
    });
  }

  return oauthErr(res, 404, 'not_found', 'not found');
}

/** 授权成功发一把 kind=oauth 的 Key（浏览器回调与设备授权共用） */
async function issueOAuthKey(
  rt: McpRuntime,
  userId: string,
  product: Product,
  clientName: string | null
): Promise<string> {
  const acct = await rt.billing.getAccount(userId);
  const tier = effectiveTier(acct);
  const created = await rt.store.create({
    scope: product,
    owner: `user:${userId}`,
    note: `${(clientName || '客户端').slice(0, 40)} 授权`,
    dailyLimit: TIERS[tier].dailyLimit,
    userId,
    kind: 'oauth',
  });
  await rt.store.pruneOAuthKeys(userId, MAX_OAUTH_KEYS).catch(() => 0);
  await track(rt, {
    event: 'key_created',
    userId,
    product,
    props: { tier, via: 'oauth', clientName },
  });
  return created.key;
}
