import * as assert from 'assert';
import { handleMcpHttp, McpRuntime } from '../src/mcp/http';
import { fakeAlipayCfg } from './fakeAlipay';
import { McpStore, ApiKeyRow } from '../src/mcp/store';
import { BillingStore } from '../src/mcp/billing';
import { Analytics, TrackInput } from '../src/mcp/analytics';
import {
  argsHash,
  countItems,
  errKind,
  maskText,
  summarizeArgs,
} from '../src/mcp/usage';
import { entitlement, maskPhone, paidUsage, sessionize } from '../src/mcp/paidUsage';

/**
 * 付费用户使用画像：调用日志补的字段口径对、不记长句原文；看板对着真 MySQL 能出数。
 */

describe('使用画像：参数摘要不记敏感原文', () => {
  it('内容标识与数字原样记，短关键词打码后记，长句只记长度', () => {
    assert.deepStrictEqual(summarizeArgs({ module: 'react', articleKey: 'hooks', limit: 5 }), {
      module: 'react', articleKey: 'hooks', limit: 5,
    });
    assert.deepStrictEqual(summarizeArgs({ keyword: '  字节  Agent ' }), { q: '字节 agent' });
    const long = summarizeArgs({ query: '我今年三十五岁在杭州做前端，月薪两万，想转 Agent 方向应该先学什么' });
    assert.deepStrictEqual(Object.keys(long!), ['qLen']);
    assert.ok(!JSON.stringify(long).includes('杭州'));
    // 短词里的手机号、邮箱、长数字也打码
    assert.deepStrictEqual(summarizeArgs({ keyword: '13812345678' }), { q: '[手机]' });
    assert.strictEqual(maskText('a@b.com 123456789'), '[邮箱] [数字]');
    // 未知参数只记名字
    assert.deepStrictEqual(summarizeArgs({ foo: 'secret text' }), { other: 'foo' });
    assert.strictEqual(summarizeArgs({}), null);
  });

  it('参数哈希：键序与空白不影响，内容不同则不同', () => {
    assert.strictEqual(argsHash({ a: 1, b: ' X ' }), argsHash({ b: 'x', a: 1 }));
    assert.notStrictEqual(argsHash({ start: '2020' }), argsHash({ start: '2021' }));
    assert.strictEqual(argsHash({}).length, 16);
  });

  it('结果条数：数组或常见列表字段，识别不出为 null', () => {
    assert.strictEqual(countItems([1, 2]), 2);
    assert.strictEqual(countItems({ items: [] }), 0);
    assert.strictEqual(countItems({ total: 3 }), null);
    assert.strictEqual(countItems('x'), null);
  });

  it('报错归类', () => {
    assert.strictEqual(errKind('缺少必填参数 slug'), 'invalid_args');
    assert.strictEqual(errKind('参数 limit 应为数字'), 'invalid_args');
    assert.strictEqual(errKind('文章不存在：hooks'), 'not_found');
    assert.strictEqual(errKind('请求超时'), 'timeout');
    assert.strictEqual(errKind('connect ECONNREFUSED 1.2.3.4'), 'upstream');
    assert.strictEqual(errKind('start 格式应为 YYYYMMDD'), 'invalid_args');
    assert.strictEqual(errKind('需要 keyword（公司 / 岗位）'), 'invalid_args');
    assert.strictEqual(errKind('面经不存在，请先用 interview_search 确认 articleKey'), 'not_found');
    assert.strictEqual(errKind('奇怪'), 'other');
    assert.strictEqual(errKind(undefined), null);
  });
});

describe('使用画像：会话与权益算术', () => {
  const t = (s: string) => `2026-11-04 ${s}`;
  it('30 分钟断开算新会话；60 秒内同工具同参数算重复，不计入连调路径', () => {
    const r = sessionize([
      { uid: 'A', tool: 'fear_series', created_at: t('10:00:00'), args_hash: 'h1' },
      { uid: 'A', tool: 'fear_series', created_at: t('10:00:05'), args_hash: 'h1' },
      { uid: 'A', tool: 'fear_series', created_at: t('10:00:10'), args_hash: 'h2' },
      { uid: 'A', tool: 'bias_series', created_at: t('10:01:00'), args_hash: 'h3' },
      { uid: 'A', tool: 'market_snapshot', created_at: t('11:00:00'), args_hash: null },
      { uid: 'B', tool: 'market_snapshot', created_at: t('11:00:01'), args_hash: null },
    ]);
    assert.strictEqual(r.summary.count, 3);
    assert.strictEqual(r.summary.maxCalls, 4);
    assert.strictEqual(r.duplicates.n, 1);
    assert.deepStrictEqual(r.duplicates.byTool, [{ tool: 'fear_series', n: 1 }]);
    assert.deepStrictEqual(r.paths.map(p => p.path).sort(), ['fear_series→bias_series', 'fear_series→fear_series']);
  });

  it('本期消耗折算成一个月的速度、还能用几天', () => {
    const now = Date.parse('2026-11-11T00:00:00Z');
    const e = entitlement({ usedCycle: 200, cycleStartMs: now - 10 * 86400000, nowMs: now, monthly: 800, balance: 600 });
    assert.deepStrictEqual(e, { cycleDays: 10, perDay: 20, monthPace: 600, pacePct: 75, daysLeft: 30 });
    // 本期不足一天按一天算；没用过 daysLeft 为 null
    const z = entitlement({ usedCycle: 0, cycleStartMs: now, nowMs: now, monthly: 800, balance: 800 });
    assert.deepStrictEqual([z.cycleDays, z.daysLeft, z.pacePct], [1, null, 0]);
    assert.strictEqual(maskPhone('13812345678'), '138****5678');
  });
});

// ── HTTP：调用日志带上画像字段，未知工具/方法记事件 ──

const KEY = 'jk_testkey';
const ROW: ApiKeyRow = {
  id: 9, key_prefix: 'jk_abc', scope: 'all', owner: 'u', note: null, status: 'active',
  daily_limit: 100, created_at: '', last_used_at: null, user_id: 'u1',
};
const call = (name: string, args: any = {}, id: any = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function fakeRt(o: { member?: boolean; paidToday?: boolean; userId?: string | null } = {}) {
  const events: TrackInput[] = [];
  const logs: any[] = [];
  const state = { points: 100 };
  const rt: McpRuntime = {
    alipay: fakeAlipayCfg,
    store: {
      findActive: async (k: string) => (k === KEY ? { ...ROW, user_id: o.userId === undefined ? 'u1' : o.userId } : null),
      countCall: async (_r: any, _n: any, limit?: number) => ({ used: 1, limit, over: false }),
      log: async (x: any) => { logs.push(x); },
    } as any,
    billing: {
      getAccount: async () => ({
        user_id: 'u1', points: state.points, tier: o.member ? 'member' : 'free', active: !!o.member,
        tier_expire_at: o.member ? '2099-01-01 00:00:00' : null,
      }),
      charge: async (_u: string, cost: number) => (state.points -= cost),
      refund: async (_u: string, cost: number) => { state.points += cost; },
      paidToday: async () => !!o.paidToday,
    } as any,
    agentDeps: () => ({} as any),
    investDeps: () => ({
      fearSeries: async () => [{ d: 1 }, { d: 2 }],
      bias: async () => ({ date: '20261028', latest: [], history: [] }),
      broad: async () => ({ date: '20261028', latest: [], dv: null }),
      fearLatest: async () => ({ trade_date: '20261028', score: 40, level: '偏热', components: {}, raw: {} }),
      macro: async () => ({ latest: [] }),
      usage: async () => ({}),
    } as any),
    isAdmin: async () => false,
    userIdOf: async () => 'u1',
    now: () => new Date('2026-12-15T12:00:00+08:00'),
    analytics: {
      track: async (e: TrackInput) => { events.push(e); },
      trackMany: async (l: TrackInput[]) => { events.push(...l); return l.length; },
    } as any,
  };
  return { rt, events, logs, state };
}

async function run(rt: McpRuntime, body: any) {
  const req: any = { method: 'POST', headers: { authorization: `Bearer ${KEY}` } };
  const res: any = { statusCode: 0, headers: {}, body: '', setHeader() {}, end(b?: any) { this.body = b ? String(b) : ''; } };
  await handleMcpHttp(req, res, new URL('http://x/mcp/invest'), rt, Buffer.from(JSON.stringify(body)));
  return res.body ? JSON.parse(res.body) : null;
}

describe('使用画像：调用日志字段', () => {
  it('会员成功调用：档位、真扣、参数摘要、哈希、结果长度与条数', async () => {
    const { rt, logs } = fakeRt({ member: true });
    await run(rt, call('fear_series', { start: '20200101', end: '20201231' }));
    const l = logs[0];
    assert.deepStrictEqual(
      [l.userId, l.tier, l.billing, l.args, l.resultItems, l.errKind],
      ['u1', 'member', 'charged', '{"start":"20200101","end":"20201231"}', 2, null]
    );
    assert.strictEqual(l.argsHash.length, 16);
    assert.ok(l.resultChars > 0);
  });

  it('历史序列当天已付记 day_pass；免费工具记 free_tool；管理员 Key 记 admin', async () => {
    const a = fakeRt({ paidToday: true });
    await run(a.rt, call('fear_series', {}));
    assert.deepStrictEqual([a.logs[0].billing, a.logs[0].cost, a.logs[0].tier], ['day_pass', 0, 'free']);
    const b = fakeRt();
    await run(b.rt, call('indicator_list'));
    assert.strictEqual(b.logs[0].billing, 'free_tool');
    const c = fakeRt({ userId: null });
    await run(c.rt, call('market_snapshot'));
    assert.deepStrictEqual([c.logs[0].billing, c.logs[0].tier, c.logs[0].userId], ['admin', 'admin', null]);
  });

  it('扣了点又失败：记 refunded 与报错归类，点数退回', async () => {
    const { rt, logs, state } = fakeRt();
    rt.investDeps = () => ({ fearSeries: async () => { throw new Error('请求超时'); } } as any);
    await run(rt, call('fear_series', { start: '20200101' }));
    assert.deepStrictEqual([logs[0].ok, logs[0].billing, logs[0].errKind, logs[0].cost], [false, 'refunded', 'timeout', 0]);
    assert.strictEqual(state.points, 100);
  });

  it('客户端调了不存在的工具或没实现的方法：记事件，不扣点', async () => {
    const { rt, events, logs, state } = fakeRt();
    await run(rt, call('stock_screener', { x: 1 }));
    await run(rt, { jsonrpc: '2.0', id: 2, method: 'resources/list' });
    await run(rt, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepStrictEqual(events.map(e => [e.event, e.props!.name || e.props!.method]), [
      ['tool_unknown', 'stock_screener'],
      ['method_unsupported', 'resources/list'],
    ]);
    assert.strictEqual(logs.length, 0);
    assert.strictEqual(state.points, 100);
  });
});

describe('付费用户视图（真 MySQL）', function () {
  this.timeout(30000);
  let conn: any;
  let q: (sql: string, params?: any[]) => Promise<any>;
  const dbName = `mcp_paid_test_${Date.now()}`;

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

  it('旧调用日志表补齐画像列；付费用户的使用、权益、报错、重复、空结果都能出数', async () => {
    await q('CREATE TABLE `user` (id VARCHAR(64) PRIMARY KEY, phoneNumber VARCHAR(20), role VARCHAR(16))');
    await q("INSERT INTO `user` VALUES ('P','13800001111','user'),('ADM','13900000000','admin'),('F','13700002222','user')");
    const store = new McpStore(q);
    const billing = new BillingStore(q);
    const a = new Analytics(q);
    await store.ensureSchema();
    const cols = (await q("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mcp_call_log'")).map((r: any) => r.c);
    for (const c of ['user_id', 'tier', 'billing', 'args', 'args_hash', 'result_chars', 'result_items', 'err_kind'])
      assert.ok(cols.includes(c), c);

    // P 付费会员；ADM 管理员付了也不算；F 免费用户只作对照
    for (const u of ['P', 'ADM', 'F']) await billing.activate(u);
    for (const u of ['P', 'ADM']) {
      const o = await billing.createOrder(u, { sku: 'member_month', listCents: 2900, kind: 'plan', tier: 'member', months: 1, points: 800 } as any, 1450);
      await billing.fulfill(o.order_no, 'alipay:T');
    }
    await store.create({ scope: 'all', owner: 'user:P', userId: 'P' });
    await store.create({ scope: 'all', owner: 'user:F', userId: 'F' });
    const kp = (await q("SELECT id FROM mcp_api_key WHERE user_id = 'P'"))[0].id;
    const kf = (await q("SELECT id FROM mcp_api_key WHERE user_id = 'F'"))[0].id;
    const base = { product: 'agent' as const, latencyMs: 100, userId: 'P', tier: 'member', client: 'claude-code/2' };
    await store.log({ ...base, keyId: kp, tool: 'interview_search', ok: true, billing: 'charged', cost: 1, args: '{"q":"字节"}', argsHash: 'h1', resultItems: 0 });
    await store.log({ ...base, keyId: kp, tool: 'interview_search', ok: true, billing: 'charged', cost: 1, args: '{"q":"字节"}', argsHash: 'h1', resultItems: 0 });
    await store.log({ ...base, keyId: kp, tool: 'knowledge_get', ok: false, billing: 'refunded', error: '文章不存在：x', errKind: 'not_found', latencyMs: 25000 });
    await store.log({ keyId: kf, product: 'agent', tool: 'knowledge_search', ok: true, latencyMs: 50 });
    await billing.charge('P', 1, 'interview_search');
    await billing.charge('P', 1, 'interview_search');
    await billing.charge('P', 5, 'iris_report');
    await a.track({ event: 'quota_exceeded', userId: 'P', product: 'agent', props: { tool: 'x', limit: 1500, tier: 'member' } });
    await a.track({ event: 'tool_unknown', userId: 'F', product: 'agent', props: { name: 'resume_review' } });
    await a.track({ event: 'mcp_initialize', userId: 'P', product: 'agent', props: { clientName: 'claude-code' } });

    const d: any = await a.paidUsage(30);
    assert.strictEqual(d.payers, 1);
    const p = d.users[0];
    assert.deepStrictEqual(
      [p.userId, p.phone, p.member, p.monthly, p.calls, p.failed, p.skillPts, p.irisPts, p.usedCycle, p.quotaHits, p.connected],
      ['P', '138****1111', true, 800, 3, 1, 2, 5, 7, 1, false]
    );
    assert.deepStrictEqual(d.adoption, { payers: 1, withKey: 1, connected: 0, calledInWindow: 1, usedIris: 1 });
    assert.strictEqual(d.entitlement.quotaHitUsers, 1);
    assert.strictEqual(d.entitlement.pointsIris, 5);
    const is = d.tools.find((t: any) => t.tool === 'interview_search');
    assert.deepStrictEqual([is.calls, is.emptyRate, is.points], [2, 100, 2]);
    assert.strictEqual(d.duplicates.n, 1);
    assert.deepStrictEqual(d.emptyQueries[0], { tool: 'interview_search', args: '{"q":"字节"}', n: 2, users: 1 });
    assert.deepStrictEqual(d.bugs.errorKinds, [{ kind: 'not_found', n: 1 }]);
    assert.strictEqual(d.bugs.slowCalls, 1);
    assert.strictEqual(d.bugs.refunded, 1);
    assert.strictEqual(d.billingMix.charged, 2);
    assert.deepStrictEqual(d.unknown, [{ event: 'tool_unknown', label: 'resume_review', n: 1, users: 1 }]);
    assert.deepStrictEqual(d.clientNames, [{ client: 'claude-code', sessions: 1, users: 1 }]);
    assert.strictEqual(d.hours.reduce((s: number, x: number) => s + x, 0), 3);
    assert.deepStrictEqual([d.compare.allActive, d.compare.paidActive], [2, 1]);
    assert.strictEqual(d.grantedMembers, 0);
  });
});
