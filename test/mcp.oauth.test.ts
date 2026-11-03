import * as assert from 'assert';
import { createHash } from 'crypto';
import { handleMcpHttp, McpRuntime } from '../src/mcp/http';
import {
  OAuthStore,
  OAuthCode,
  redirectAllowed,
  validRedirectUri,
  productFromResource,
  publicBase,
  displayClientName,
  s256,
  MAX_OAUTH_KEYS,
} from '../src/mcp/oauth';
import { McpStore } from '../src/mcp/store';

/** 内存版 OAuthStore：与真表同语义（一次性、10 分钟过期） */
export class MemOAuth {
  clients = new Map<string, any>();
  codes = new Map<string, OAuthCode & { used: boolean; exp: number }>();
  now = () => Date.now();
  async registerClient(name: string | null, uris: string[]) {
    const id = 'jc_' + Math.random().toString(36).slice(2);
    this.clients.set(id, { client_id: id, client_name: name, redirect_uris: uris });
    return id;
  }
  async getClient(id: string) {
    return this.clients.get(id) || null;
  }
  async createCode(c: OAuthCode) {
    const code = 'jac_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    this.codes.set(code, { ...c, used: false, exp: this.now() + 10 * 60_000 });
    return code;
  }
  async consumeCode(code: string) {
    const c = this.codes.get(code);
    if (!c || c.used || c.exp <= this.now()) return null;
    c.used = true;
    const { used, exp, ...rest } = c;
    void used;
    void exp;
    return rest;
  }
}

export function memRuntime(over: Partial<McpRuntime> = {}) {
  const keys: any[] = [];
  const oauth = new MemOAuth();
  const activated: string[] = [];
  const store: any = {
    findActive: async (k: string) => keys.find(x => x.key === k && x.status === 'active')?.row || null,
    statusOf: async (k: string) => keys.find(x => x.key === k)?.status || null,
    countCall: async () => ({ used: 1, limit: 100, over: false }),
    log: async () => {},
    markConnected: async () => {},
    create: async (p: any) => {
      const key = 'jk_' + Math.random().toString(36).slice(2);
      const row = { id: keys.length + 1, key_prefix: key.slice(0, 10), scope: p.scope, owner: p.owner, note: p.note, status: 'active', daily_limit: p.dailyLimit, created_at: '', last_used_at: null, user_id: p.userId, kind: p.kind };
      keys.push({ key, row, get status() { return row.status; } });
      return { key, prefix: row.key_prefix };
    },
    pruneOAuthKeys: async (userId: string, keep: number) => {
      const mine = keys.filter(k => k.row.user_id === userId && k.row.kind === 'oauth' && k.row.status === 'active').reverse();
      mine.slice(keep).forEach(k => { k.row.status = 'revoked'; });
      return Math.max(0, mine.length - keep);
    },
  };
  const billing: any = {
    getAccount: async (u: string) => (activated.includes(u) ? { user_id: u, points: 50, tier: 'free', active: false } : null),
    activate: async (u: string) => {
      const created = !activated.includes(u);
      if (created) activated.push(u);
      return { created };
    },
    charge: async () => 40,
    refund: async () => {},
  };
  const rt: McpRuntime = {
    store,
    billing,
    oauth: oauth as any,
    agentDeps: () => ({ usage: async () => ({}) } as any),
    investDeps: () => ({ usage: async () => ({}) } as any),
    isAdmin: async () => false,
    userIdOf: async (h: any) => (h.token === 'login-u1' ? 'u1' : null),
    now: () => new Date('2026-11-10T12:00:00+08:00'),
    ...over,
  };
  return { rt, keys, oauth, activated };
}

export async function run(rt: McpRuntime, opts: { method?: string; path: string; headers?: any; body?: any; host?: string }) {
  const req: any = { method: opts.method || 'GET', headers: { host: opts.host || 'fe.example.com', ...(opts.headers || {}) } };
  const res: any = {
    statusCode: 0, headers: {} as any, body: '',
    setHeader(k: string, v: any) { this.headers[k.toLowerCase()] = v; },
    end(b?: any) { this.body = b ? String(b) : ''; },
  };
  const url = new URL(`http://x${opts.path}`);
  const raw = opts.body === undefined ? '' : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  await handleMcpHttp(req, res, url, rt, Buffer.from(raw));
  let json: any = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
  return { status: res.statusCode, json, headers: res.headers, body: res.body };
}

const VERIFIER = 'a'.repeat(20) + 'B'.repeat(20) + '-._~123';
const CHALLENGE = s256(VERIFIER);
const CB = 'http://localhost:54321/callback';

async function register(rt: McpRuntime, uris = [CB]) {
  const r = await run(rt, { method: 'POST', path: '/mcp/oauth/register', headers: { 'content-type': 'application/json' }, body: { client_name: 'Claude Code (invest-journey)', redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' } });
  assert.strictEqual(r.status, 201, r.body);
  return r.json.client_id as string;
}

function authzQuery(clientId: string, over: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:61000/callback', state: 'st1',
    code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'mcp',
    resource: 'https://fe.example.com/mcp/invest', ...over,
  }).toString();
}

describe('MCP OAuth（一句话安装）', () => {
  it('s256 = base64url(sha256(verifier))，无填充（对照 Python hashlib 算出的值）', () => {
    assert.strictEqual(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWEOEjXk'), 'TP3DZQl9rJnri9eRuZaFS6Q7czCrth7sEZC00LreApo');
    assert.strictEqual(createHash('sha256').digest('hex').length, 64);
  });

  it('回调地址：https / 回环 http / 自定义协议可以，公网 http 与 javascript 不行；回环不比端口', () => {
    assert.ok(validRedirectUri('https://claude.ai/api/mcp/auth_callback'));
    assert.ok(validRedirectUri('http://127.0.0.1:8080/cb'));
    assert.ok(validRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'));
    assert.ok(!validRedirectUri('http://evil.com/cb'));
    assert.ok(!validRedirectUri('javascript:alert(1)'));
    assert.ok(!validRedirectUri('https://a.com/cb#frag'));
    const c = { client_id: 'x', client_name: null, redirect_uris: [CB, 'https://claude.ai/api/mcp/auth_callback'] };
    assert.ok(redirectAllowed(c, 'http://localhost:9999/callback'));
    assert.ok(!redirectAllowed(c, 'http://localhost:9999/other'));
    assert.ok(redirectAllowed(c, 'https://claude.ai/api/mcp/auth_callback'));
    assert.ok(!redirectAllowed(c, 'https://claude.ai/api/mcp/other'));
  });

  it('授权页客户端名去掉括号里的服务名', () => {
    assert.strictEqual(displayClientName('Claude Code (plugin:invest-journey:invest-journey)'), 'Claude Code');
    assert.strictEqual(displayClientName('Cursor'), 'Cursor');
    assert.strictEqual(displayClientName(null), '你的客户端');
  });

  it('productFromResource 与 publicBase', () => {
    assert.strictEqual(productFromResource('https://h/mcp/invest'), 'invest');
    assert.strictEqual(productFromResource('https://h/mcp/agent/'), 'agent');
    assert.strictEqual(productFromResource('https://h/mcp/other'), null);
    assert.strictEqual(publicBase({ host: 'fe.example.com' }), 'https://fe.example.com');
    assert.strictEqual(publicBase({ host: 'localhost:7001' }), 'http://localhost:7001');
  });

  it('无 Key 的 MCP 请求 401 带 WWW-Authenticate 发现入口；吊销的带 invalid_token', async () => {
    const { rt } = memRuntime();
    const r = await run(rt, { method: 'POST', path: '/mcp/invest', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
    assert.strictEqual(r.status, 401);
    assert.ok(/resource_metadata="https:\/\/fe\.example\.com\/\.well-known\/oauth-protected-resource\/mcp\/invest"/.test(r.headers['www-authenticate']));
    const r2 = await run(rt, { method: 'POST', path: '/mcp/agent', headers: { authorization: 'Bearer jk_nope' }, body: {} });
    assert.ok(/error="invalid_token"/.test(r2.headers['www-authenticate']));
  });

  it('发现：资源元数据指向本产品的授权服务器，授权服务器元数据含注册 / PKCE', async () => {
    const { rt } = memRuntime();
    const pr = await run(rt, { path: '/.well-known/oauth-protected-resource/mcp/invest' });
    assert.strictEqual(pr.status, 200);
    assert.strictEqual(pr.json.resource, 'https://fe.example.com/mcp/invest');
    assert.deepStrictEqual(pr.json.authorization_servers, ['https://fe.example.com/mcp/invest']);
    for (const p of ['/.well-known/oauth-authorization-server/mcp/invest', '/.well-known/openid-configuration/mcp/invest', '/mcp/invest/.well-known/openid-configuration']) {
      const as = await run(rt, { path: p });
      assert.strictEqual(as.status, 200, p);
      assert.strictEqual(as.json.issuer, 'https://fe.example.com/mcp/invest');
      assert.strictEqual(as.json.authorization_endpoint, 'https://fe.example.com/mcp/oauth/invest/authorize');
      assert.deepStrictEqual(as.json.code_challenge_methods_supported, ['S256']);
      assert.ok(as.json.registration_endpoint.endsWith('/mcp/oauth/register'));
    }
    const root = await run(rt, { path: '/.well-known/oauth-authorization-server' });
    assert.strictEqual(root.json.authorization_endpoint, 'https://fe.example.com/mcp/oauth/authorize');
  });

  it('注册拒绝公网 http 回调', async () => {
    const { rt } = memRuntime();
    const r = await run(rt, { method: 'POST', path: '/mcp/oauth/register', headers: { 'content-type': 'application/json' }, body: { redirect_uris: ['http://evil.com/cb'] } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'invalid_redirect_uri');
  });

  it('完整流程：注册 → 授权跳本站授权页 → 登录用户授权（自动开通）→ 换 token → 用 token 调 MCP', async () => {
    const { rt, activated, keys } = memRuntime();
    const id = await register(rt);
    const a = await run(rt, { path: `/mcp/oauth/invest/authorize?${authzQuery(id)}` });
    assert.strictEqual(a.status, 302);
    const page = new URL(a.headers.location);
    assert.strictEqual(page.origin + page.pathname, 'https://invest-journey.vercel.app/skills/authorize');
    assert.strictEqual(page.searchParams.get('state'), 'st1');

    // 授权页取客户端信息
    const info = await run(rt, { path: `/mcp/oauth/client?${page.searchParams.toString()}` });
    assert.strictEqual(info.json.data.clientName, 'Claude Code');
    assert.strictEqual(info.json.data.local, true);
    assert.ok(info.json.data.denyUrl.startsWith('http://localhost:61000/callback?error=access_denied'));

    // 未登录不能授权
    const params = Object.fromEntries(page.searchParams.entries());
    const no = await run(rt, { method: 'POST', path: '/mcp/me/oauth/approve', headers: { 'content-type': 'application/json' }, body: { ...params, product: 'invest' } });
    assert.strictEqual(no.status, 401);

    const ok = await run(rt, { method: 'POST', path: '/mcp/me/oauth/approve', headers: { 'content-type': 'application/json', token: 'login-u1' }, body: { ...params, product: 'invest' } });
    assert.strictEqual(ok.status, 200, ok.body);
    assert.deepStrictEqual(activated, ['u1']);
    assert.strictEqual(ok.json.data.newAccount, true);
    const back = new URL(ok.json.data.redirect);
    assert.strictEqual(back.searchParams.get('state'), 'st1');
    const code = back.searchParams.get('code')!;

    const form = (o: any) => new URLSearchParams(o).toString();
    const tokenReq = (o: any) => run(rt, { method: 'POST', path: '/mcp/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(o) });
    // PKCE 错
    const bad = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:61000/callback', client_id: id, code_verifier: 'x'.repeat(43) });
    assert.strictEqual(bad.json.error, 'invalid_grant');
    // 授权码一次性：上面那次已经把它用掉了，按规范整码作废
    const again = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:61000/callback', client_id: id, code_verifier: VERIFIER });
    assert.strictEqual(again.json.error, 'invalid_grant');

    // 重新授权一次，正确换 token
    const ok2 = await run(rt, { method: 'POST', path: '/mcp/me/oauth/approve', headers: { 'content-type': 'application/json', token: 'login-u1' }, body: { ...params, product: 'invest' } });
    assert.strictEqual(ok2.json.data.newAccount, false);
    const code2 = new URL(ok2.json.data.redirect).searchParams.get('code')!;
    const t = await tokenReq({ grant_type: 'authorization_code', code: code2, redirect_uri: 'http://localhost:61000/callback', client_id: id, code_verifier: VERIFIER });
    assert.strictEqual(t.status, 200, t.body);
    assert.strictEqual(t.json.token_type, 'Bearer');
    assert.ok(t.json.access_token.startsWith('jk_'));
    assert.strictEqual(t.headers['cache-control'], 'no-store');
    assert.strictEqual(keys[0].row.kind, 'oauth');
    assert.strictEqual(keys[0].row.scope, 'invest');
    assert.strictEqual(keys[0].row.user_id, 'u1');

    const init = await run(rt, { method: 'POST', path: '/mcp/invest', headers: { authorization: `Bearer ${t.json.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } });
    assert.strictEqual(init.status, 200, init.body);
    assert.strictEqual(init.json.result.serverInfo.name, 'invest-journey');
    // Invest 授权的 token 不能调 Agent
    const cross = await run(rt, { method: 'POST', path: '/mcp/agent', headers: { authorization: `Bearer ${t.json.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
    assert.strictEqual(cross.status, 403);
  });

  it('回调地址与注册不符：出错误页，不跳转（防开放跳转）；PKCE 缺失：带 error 跳回客户端', async () => {
    const { rt } = memRuntime();
    const id = await register(rt);
    const evil = await run(rt, { path: `/mcp/oauth/invest/authorize?${authzQuery(id, { redirect_uri: 'https://evil.com/cb' })}` });
    assert.strictEqual(evil.status, 400);
    assert.ok(!evil.headers.location);
    assert.ok(/回调地址/.test(evil.body));
    const nopkce = await run(rt, { path: `/mcp/oauth/invest/authorize?${authzQuery(id, { code_challenge_method: 'plain' })}` });
    assert.strictEqual(nopkce.status, 302);
    assert.ok(nopkce.headers.location.startsWith('http://localhost:61000/callback?error=invalid_request'));
    const unknown = await run(rt, { path: `/mcp/oauth/invest/authorize?${authzQuery('jc_nope')}` });
    assert.strictEqual(unknown.status, 400);
  });

  it('根路径授权端点按 resource 判断产品：Agent 去 Agent 站', async () => {
    const { rt } = memRuntime();
    const id = await register(rt);
    const a = await run(rt, { path: `/mcp/oauth/authorize?${authzQuery(id, { resource: 'https://fe.example.com/mcp/agent' })}` });
    assert.strictEqual(a.status, 302);
    assert.ok(a.headers.location.startsWith('https://www.agent-journey.cn/developer/authorize?'));
  });

  it('授权发的 Key 只留最新几把，不占手动建 Key 名额', async () => {
    const { rt, keys } = memRuntime();
    const id = await register(rt);
    const page = new URL((await run(rt, { path: `/mcp/oauth/invest/authorize?${authzQuery(id)}` })).headers.location);
    const params = Object.fromEntries(page.searchParams.entries());
    for (let i = 0; i < MAX_OAUTH_KEYS + 2; i++) {
      const ok = await run(rt, { method: 'POST', path: '/mcp/me/oauth/approve', headers: { 'content-type': 'application/json', token: 'login-u1' }, body: { ...params, product: 'invest' } });
      const code = new URL(ok.json.data.redirect).searchParams.get('code')!;
      const t = await run(rt, { method: 'POST', path: '/mcp/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: params.redirect_uri, client_id: id, code_verifier: VERIFIER }).toString() });
      assert.strictEqual(t.status, 200);
    }
    assert.strictEqual(keys.filter(k => k.row.status === 'active').length, MAX_OAUTH_KEYS);
    assert.strictEqual(keys[0].row.status, 'revoked');
  });

  it('OAuthStore SQL：授权码一次性取用、过期由库判断', async () => {
    const sqls: string[] = [];
    let affected = 1;
    const q = async (sql: string) => {
      sqls.push(sql);
      if (/^UPDATE mcp_oauth_code/.test(sql)) return { affectedRows: affected };
      if (/^SELECT client_id, user_id/.test(sql)) return [{ client_id: 'c', user_id: 'u', product: 'invest', redirect_uri: CB, code_challenge: CHALLENGE }];
      return [];
    };
    const s = new OAuthStore(q);
    assert.strictEqual((await s.consumeCode('jac_x'))!.product, 'invest');
    assert.ok(sqls.some(x => /used_at IS NULL AND expires_at > NOW\(\)/.test(x)));
    affected = 0;
    assert.strictEqual(await s.consumeCode('jac_x'), null);
  });

  it('McpStore：手动 Key 计数排除授权 Key；prune 吊销第 keep 把之后的', async () => {
    const sqls: { sql: string; params?: any[] }[] = [];
    const q = async (sql: string, params?: any[]) => {
      sqls.push({ sql, params });
      if (/information_schema/.test(sql)) return [{ c: 'user_id' }, { c: 'connected_at' }, { c: 'kind' }, { c: 'cost' }, { c: 'client' }];
      if (/^SELECT id FROM mcp_api_key/.test(sql)) return [{ id: 3 }, { id: 2 }];
      if (/COUNT/.test(sql)) return [{ n: 1 }];
      return { affectedRows: 2 };
    };
    const s = new McpStore(q);
    assert.strictEqual(await s.countActiveByUser('u'), 1);
    assert.ok(sqls.some(x => /kind IS NULL OR kind <> 'oauth'/.test(x.sql)));
    assert.strictEqual(await s.pruneOAuthKeys('u', 5), 2);
    assert.ok(sqls.some(x => /LIMIT 5, 100/.test(x.sql)));
    assert.deepStrictEqual(sqls[sqls.length - 1].params, ['u', 3, 2]);
  });
});
