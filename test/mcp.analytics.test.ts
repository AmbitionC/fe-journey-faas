import * as assert from 'assert';
import { handleMcpHttp, McpRuntime } from '../src/mcp/http';
import { McpStore, ApiKeyRow } from '../src/mcp/store';
import { BillingStore } from '../src/mcp/billing';
import {
  Analytics,
  cleanProps,
  clientOf,
  sanitizeWebBatch,
  TrackInput,
} from '../src/mcp/analytics';
import { InvestDeps } from '../src/mcp/tools/invest';

/**
 * 埋点：事件在该记的节点记了、字段对、埋点挂了不影响业务；看板 SQL 对着真 MySQL 跑。
 */

const call = (name: string, args: any = {}, id: any = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

function investDeps(): InvestDeps {
  return {
    fearLatest: async () => ({ trade_date: '20261028', score: 40, level: '偏热', components: {}, raw: {} }),
    fearSeries: async () => [],
    bias: async () => ({ date: '20261028', latest: [], history: [] }),
    broad: async () => ({ date: '20261028', latest: [], dv: null }),
    macro: async () => ({ latest: [] }),
    usage: async () => ({}),
  } as any;
}

const HALF = () => new Date('2026-12-15T12:00:00+08:00');
const KEY = 'jk_testkey';
const USER_ROW: ApiKeyRow = {
  id: 9, key_prefix: 'jk_abc', scope: 'all', owner: 'u', note: null, status: 'active',
  daily_limit: 100, created_at: '', last_used_at: null, user_id: 'u1',
};

function fakeRt(opts: { points?: number; over?: boolean; analytics?: any; userId?: string | null } = {}) {
  const events: TrackInput[] = [];
  const logs: any[] = [];
  const state = { points: opts.points ?? 10 };
  const analytics = opts.analytics ?? {
    track: async (e: TrackInput) => { events.push(e); },
    trackMany: async (l: TrackInput[]) => { events.push(...l); return l.length; },
  };
  const rt: McpRuntime = {
    store: {
      findActive: async (k: string) => (k === KEY ? USER_ROW : null),
      countCall: async (_r: any, _n: any, limit?: number) => ({ used: 1, limit, over: !!opts.over }),
      log: async (x: any) => { logs.push(x); },
      create: async () => ({ key: 'jk_new', prefix: 'jk_new' }),
      countActiveByUser: async () => 0,
    } as any,
    billing: {
      getAccount: async () => ({ user_id: 'u1', points: state.points, tier: 'free', active: false }),
      charge: async (_u: string, cost: number) => {
        if (state.points < cost) return null;
        state.points -= cost;
        return state.points;
      },
      refund: async (_u: string, cost: number) => { state.points += cost; },
      activate: async () => ({ created: true }),
      createOrder: async (_u: string, sku: any, amount: number) => ({ order_no: 'MJ20261215ABCDEF12', sku: sku.sku, amount_cents: amount, status: 'pending', reused: false }),
    } as any,
    agentDeps: () => ({} as any),
    investDeps: () => investDeps(),
    isAdmin: async () => false,
    userIdOf: async () => (opts.userId === undefined ? 'u1' : opts.userId),
    now: HALF,
    analytics,
  };
  return { rt, events, logs, state };
}

async function run(rt: McpRuntime, o: { method?: string; path?: string; headers?: any; body?: any }) {
  const req: any = { method: o.method || 'POST', headers: o.headers || {} };
  const res: any = {
    statusCode: 0, headers: {} as any, body: '',
    setHeader(k: string, v: any) { this.headers[k.toLowerCase()] = v; },
    end(b?: any) { this.body = b ? String(b) : ''; },
  };
  const raw = o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  await handleMcpHttp(req, res, new URL(`http://x${o.path || '/mcp/invest'}`), rt, Buffer.from(raw));
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const auth = { authorization: `Bearer ${KEY}`, 'x-journey-client': 'plugin/invest-journey@0.2.0' };

describe('MCP 埋点：校验', () => {
  it('前端事件只收白名单事件与两个 Skill 页，anonId 不合法置空', () => {
    const out = sanitizeWebBatch({
      anonId: 'a_12345678',
      events: [
        { event: 'page_view', page: 'agent_developer', props: { referrer: 'https://x.com/a' } },
        { event: 'drop_table', page: 'agent_developer' },
        { event: 'copy_click', page: 'other_page' },
        { event: 'copy_click', page: 'invest_skills', props: { label: 'mcp_json', client: 'cursor' } },
      ],
    }, 'u9');
    assert.deepStrictEqual(out.map(e => [e.event, e.product, e.userId, e.anonId]), [
      ['page_view', 'agent', 'u9', 'a_12345678'],
      ['copy_click', 'invest', 'u9', 'a_12345678'],
    ]);
    assert.strictEqual(sanitizeWebBatch({ anonId: 'bad id!', events: [{ event: 'page_view', page: 'invest_skills' }] }, null)[0].anonId, null);
    // 批量上限 30
    const many = sanitizeWebBatch({ anonId: 'a_12345678', events: Array.from({ length: 100 }, () => ({ event: 'faq_open', page: 'invest_skills' })) }, null);
    assert.strictEqual(many.length, 30);
  });

  it('props 只留浅层基础类型、截断长串', () => {
    const p = cleanProps({ a: 'x'.repeat(500), b: 2, c: { deep: 1 }, 'bad-key': 1, d: true, e: NaN });
    assert.deepStrictEqual(Object.keys(p!), ['a', 'b', 'd']);
    assert.strictEqual(p!.a.length, 200);
    assert.strictEqual(cleanProps([1]), null);
  });

  it('客户端标识：插件头优先，其次 User-Agent 首段', () => {
    assert.strictEqual(clientOf({ 'x-journey-client': 'plugin/agent-journey@0.2.0', 'user-agent': 'node' }), 'plugin/agent-journey@0.2.0');
    assert.strictEqual(clientOf({ 'user-agent': 'claude-code/2.0.1 (cli)' }), 'claude-code/2.0.1');
    assert.strictEqual(clientOf({}), null);
  });
});

describe('MCP 埋点：后端节点', () => {
  it('握手记 mcp_initialize：客户端名、版本、经插件安装', async () => {
    const { rt, events } = fakeRt();
    await run(rt, { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.0.1' } } } });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'mcp_initialize');
    assert.strictEqual(events[0].userId, 'u1');
    assert.strictEqual(events[0].product, 'invest');
    assert.deepStrictEqual([events[0].props!.clientName, events[0].props!.via], ['claude-code', 'plugin']);
  });

  it('缺 Key / 错 Key 记 auth_failed（装了但没配好 Key）', async () => {
    const { rt, events } = fakeRt();
    await run(rt, { body: call('market_snapshot') });
    await run(rt, { headers: { authorization: 'Bearer jk_wrong' }, body: call('market_snapshot') });
    assert.deepStrictEqual(events.map(e => [e.event, e.props!.reason]), [['auth_failed', 'missing'], ['auth_failed', 'invalid']]);
  });

  it('成功调用：日志带实扣点数与客户端', async () => {
    const { rt, logs } = fakeRt({ points: 10 });
    await run(rt, { headers: auth, body: call('market_snapshot') });
    assert.strictEqual(logs.length, 1);
    assert.deepStrictEqual([logs[0].ok, logs[0].cost, logs[0].client], [true, 2, 'plugin/invest-journey@0.2.0']);
  });

  it('失败调用退点，日志实扣记 0', async () => {
    const { rt, logs, state } = fakeRt({ points: 10 });
    await run(rt, { headers: auth, body: call('fear_series', { start: 'bad' }) });
    assert.strictEqual(state.points, 10);
    assert.strictEqual(logs[0].cost, 0);
  });

  it('点数不足记 credit_exhausted（工具、单价、余额、档位、阶段）', async () => {
    const { rt, events } = fakeRt({ points: 1 });
    const r = await run(rt, { headers: auth, body: call('market_snapshot') });
    assert.strictEqual(r.json.result.isError, true);
    const e = events.find(x => x.event === 'credit_exhausted')!;
    assert.deepStrictEqual(e.props, { tool: 'market_snapshot', cost: 2, balance: 1, tier: 'free', phase: 'half' });
    assert.strictEqual(e.userId, 'u1');
  });

  it('每日额度用完记 quota_exceeded', async () => {
    const { rt, events } = fakeRt({ over: true });
    await run(rt, { headers: auth, body: call('market_snapshot') });
    assert.strictEqual(events[0].event, 'quota_exceeded');
    assert.strictEqual(events[0].props!.tool, 'market_snapshot');
  });

  it('埋点写库抛错不影响调用', async () => {
    const { rt } = fakeRt({ analytics: { track: async () => { throw new Error('db down'); } } });
    const r = await run(rt, { headers: auth, body: call('market_snapshot') });
    assert.ok(!r.json.result.isError);
  });

  it('开通、建 Key、下单各记一条', async () => {
    const { rt, events } = fakeRt();
    await run(rt, { path: '/mcp/me/activate', body: {} });
    await run(rt, { path: '/mcp/me/keys', body: { name: 'k' } });
    await run(rt, { path: '/mcp/me/orders', body: { sku: 'member_month' } });
    const names = events.map(e => e.event);
    assert.deepStrictEqual(names.slice(0, 3), ['account_activated', 'trial_granted', 'key_created']);
    const o = events.find(e => e.event === 'order_created')!;
    assert.deepStrictEqual([o.props!.sku, o.props!.amountCents, o.props!.listCents, o.props!.phase], ['member_month', 1450, 2900, 'half']);
  });

  it('POST /mcp/track 回 204 并带上登录用户', async () => {
    const { rt, events } = fakeRt({ userId: 'u7' });
    const r = await run(rt, { path: '/mcp/track', body: { anonId: 'a_12345678', events: [{ event: 'page_view', page: 'invest_skills' }] } });
    assert.strictEqual(r.status, 204);
    assert.deepStrictEqual([events[0].event, events[0].userId, events[0].source], ['page_view', 'u7', 'web']);
    const bad = await run(rt, { path: '/mcp/track', body: '{oops' });
    assert.strictEqual(bad.status, 204);
  });
});

describe('MCP 埋点：看板（真 MySQL）', function () {
  this.timeout(30000);
  let conn: any;
  let q: (sql: string, params?: any[]) => Promise<any>;
  const dbName = `mcp_analytics_test_${Date.now()}`;

  before(async function () {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mysql = require('mysql2/promise');
      conn = await mysql.createConnection({
        host: process.env.MCP_TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
        user: process.env.MCP_TEST_DB_USER || process.env.DB_USER || 'root',
        password: process.env.MCP_TEST_DB_PASS ?? process.env.DB_PASS ?? '',
        connectTimeout: 3000,
        dateStrings: true,
      });
      await conn.query(`CREATE DATABASE \`${dbName}\``);
      await conn.query(`USE \`${dbName}\``);
    } catch {
      this.skip();
    }
    q = async (sql, params) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    };
  });

  after(async () => {
    if (conn) {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
      await conn.end().catch(() => {});
    }
  });

  it('旧版调用日志表自动补 cost / client 列', async () => {
    await q(`CREATE TABLE mcp_call_log (id BIGINT AUTO_INCREMENT PRIMARY KEY, key_id INT NOT NULL, product VARCHAR(16) NOT NULL,
      tool VARCHAR(64) NOT NULL, ok TINYINT NOT NULL DEFAULT 1, latency_ms INT NOT NULL DEFAULT 0, error VARCHAR(300) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const store = new McpStore(q);
    await store.ensureSchema();
    const cols = (await q("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mcp_call_log'")).map((r: any) => r.c);
    assert.ok(cols.includes('cost') && cols.includes('client'));
  });

  it('漏斗按同一批开通用户往下追；耗尽、留存、工具、客户端、付款都能出数', async () => {
    const store = new McpStore(q);
    const billing = new BillingStore(q);
    const a = new Analytics(q);
    // 三个访客，两个看了安装方式
    await a.trackMany([
      ...['v1', 'v2', 'v3'].map(id => ({ event: 'page_view', source: 'web' as const, anonId: `anon_${id}xxxx`, page: 'invest_skills', product: 'invest', props: { referrer: 'https://www.zhihu.com/q/1' } })),
      ...['v1', 'v2'].map(id => ({ event: 'copy_click', source: 'web' as const, anonId: `anon_${id}xxxx`, page: 'invest_skills', product: 'invest', props: { label: 'install_cmd', client: 'claude-code' } })),
    ]);
    // 两人开通：A 建 Key、调用两天、点数用完、下单并付款；B 只开通
    await billing.activate('A');
    await billing.activate('B');
    await store.create({ scope: 'all', owner: 'user:A', userId: 'A' });
    const keyId = (await q("SELECT id FROM mcp_api_key WHERE user_id = 'A'"))[0].id;
    await a.track({ event: 'mcp_initialize', userId: 'A', product: 'invest', props: { clientName: 'claude-code', via: 'plugin' } });
    await store.log({ keyId, product: 'invest', tool: 'market_snapshot', ok: true, latencyMs: 120, cost: 2, client: 'plugin/x' });
    await store.log({ keyId, product: 'invest', tool: 'market_snapshot', ok: false, latencyMs: 900, error: 'boom' });
    await q('UPDATE mcp_call_log SET created_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE ok = 0');
    await store.log({ keyId, product: 'invest', tool: 'fear_series', ok: true, latencyMs: 300, cost: 2 });
    await q("UPDATE mcp_call_log SET created_at = DATE_SUB(NOW(), INTERVAL 1 DAY), ok = 1 WHERE tool = 'fear_series'");
    await a.track({ event: 'credit_exhausted', userId: 'A', product: 'invest', props: { tool: 'fear_series', cost: 2, balance: 0, tier: 'free', phase: 'half' } });
    const o = await billing.createOrder('A', { sku: 'member_month', listCents: 2900 } as any, 1450);
    await billing.fulfill(o.order_no, 'alipay:T1');
    await a.track({ event: 'order_paid', userId: 'A', props: { orderNo: o.order_no, sku: 'member_month', amountCents: 1450, channel: 'alipay' } });

    const d = await a.dashboard(30, null);
    const n = Object.fromEntries(d.funnel.map((s: any) => [s.step, s.n]));
    assert.deepStrictEqual(n, {
      visit: 3, install_intent: 2, activated: 2, key: 1, connected: 1, first_call: 1, repeat: 1, exhausted: 1, ordered: 1, paid: 1,
    });
    assert.strictEqual(d.credit.exhaustedUsers, 1);
    assert.strictEqual(d.credit.paidAfterExhaust, 1);
    const ms = d.tools.find((t: any) => t.tool === 'market_snapshot')!;
    assert.deepStrictEqual([ms.calls, ms.failed, ms.points, ms.p95], [2, 1, 2, 900]);
    assert.deepStrictEqual(d.clients[0], { client: 'claude-code', via: 'plugin', sessions: 1, users: 1 });
    assert.deepStrictEqual(d.sources[0], { source: 'www.zhihu.com', visitors: 3 });
    assert.ok(d.interactions.some((x: any) => x.event === 'copy_click' && x.label === 'install_cmd' && x.visitors === 2));
    assert.deepStrictEqual(d.payments.map((p: any) => [p.event, p.channel, p.cents]), [['order_paid', 'alipay', 1450]]);
    assert.strictEqual(d.retention.cohorts.reduce((s: number, c: any) => s + c.size, 0), 2);
    // 按产品拆：agent 没有页面与调用
    const ag = await a.dashboard(30, 'agent');
    const na = Object.fromEntries(ag.funnel.map((s: any) => [s.step, s.n]));
    assert.deepStrictEqual([na.visit, na.first_call, na.activated], [0, 0, 2]);
  });
});
