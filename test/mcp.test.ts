import * as assert from 'assert';
import { handleMessage, validateArgs, MAX_TEXT_CHARS } from '../src/mcp/protocol';
import { agentServer, AgentDeps, slimTree } from '../src/mcp/tools/agent';
import { investServer, InvestDeps } from '../src/mcp/tools/invest';
import { METHODOLOGY } from '../src/mcp/methodology';
import { handleMcpHttp, McpRuntime } from '../src/mcp/http';
import { McpStore, extractKey, hashKey, generateKey, beijingYmd, ApiKeyRow } from '../src/mcp/store';

const call = (name: string, args: any = {}, id: any = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

function agentDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    getNavList: async () => ({ navData: [{ label: 'JS', children: [{ key: 'closure', label: '闭包', isLeaf: true, filePath: 'js' }] }] }),
    searchContent: async () => [{ module: 'knowledge', articleKey: 'closure', title: '闭包', snippet: '…', score: 1, filePath: 'js' }],
    retrieve: async () => [],
    getContent: async (m, k) => ({ module: m, articleKey: k, title: '闭包', content: '# 闭包' }),
    searchInterviews: async () => ({ list: [], total: 0 }),
    getInterview: async () => null,
    listMissions: async () => [],
    getMission: async () => null,
    listQuiz: async () => [],
    usage: async () => ({}),
    ...over,
  };
}

const BROAD_ROW = {
  trade_date: '20261028', leg: '沪深300', etf: '510300', close: 4000, median: 3600,
  buy_line: 3600, sell_line: 4680, state: 'hold', shares: 1000, mkt_value: 4000000, cost_price: 3.5,
  data_date: '20261028',
};

function investDeps(over: Partial<InvestDeps> = {}): InvestDeps {
  return {
    fearLatest: async () => ({ trade_date: '20261028', score: 40, level: '偏热/贪婪', components: { 动量: 30 }, raw: { n: 5000 } }),
    fearSeries: async () => [],
    bias: async () => ({ date: '20261028', latest: [], history: [] }),
    broad: async () => ({ date: '20261028', latest: [BROAD_ROW], dv: null }),
    macro: async () => ({ latest: [] }),
    usage: async () => ({}),
    ...over,
  };
}

describe('MCP 协议核心', () => {
  it('initialize 回协商版本与 tools 能力；未知版本回最新版', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, agentServer, agentDeps());
    assert.strictEqual(r.result.protocolVersion, '2025-03-26');
    assert.ok(r.result.capabilities.tools);
    assert.strictEqual(r.result.serverInfo.name, 'agent-journey');
    const r2 = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, agentServer, agentDeps());
    assert.strictEqual(r2.result.protocolVersion, '2025-06-18');
  });

  it('通知与客户端回包不回响应', async () => {
    assert.strictEqual(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, agentServer, agentDeps()), null);
    assert.strictEqual(await handleMessage({ jsonrpc: '2.0', id: 9, result: {} }, agentServer, agentDeps()), null);
  });

  it('未知方法 -32601，未知工具 -32602', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, agentServer, agentDeps());
    assert.strictEqual(r.error.code, -32601);
    const r2 = await handleMessage(call('nope'), agentServer, agentDeps());
    assert.strictEqual(r2.error.code, -32602);
  });

  it('tools/list 全部工具都标只读', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, investServer, investDeps());
    assert.ok(r.result.tools.length >= 6);
    for (const t of r.result.tools) assert.strictEqual(t.annotations.readOnlyHint, true);
  });

  it('缺必填参数返回 isError 且记账为失败', async () => {
    const recs: any[] = [];
    const r = await handleMessage(call('knowledge_get', { module: 'knowledge' }), agentServer, agentDeps(), (x) => { recs.push(x); });
    assert.strictEqual(r.result.isError, true);
    assert.strictEqual(recs[0].ok, false);
  });

  it('工具抛错转为 isError，不泄漏堆栈', async () => {
    const deps = agentDeps({ getNavList: async () => { throw new Error('boom'); } });
    const r = await handleMessage(call('knowledge_tree', { module: 'knowledge' }), agentServer, deps);
    assert.strictEqual(r.result.isError, true);
    assert.strictEqual(r.result.content[0].text, 'boom');
  });

  it('超长结果截断', async () => {
    const deps = agentDeps({ getContent: async () => ({ articleKey: 'k', title: 't', content: 'x'.repeat(59_000) }) });
    const big = agentDeps({
      searchInterviews: async () => ({ list: Array.from({ length: 30 }, (_, i) => ({ id: i, title: 'x'.repeat(5000), aiContent: 'y'.repeat(5000) })), total: 30 }),
    });
    const r = await handleMessage(call('knowledge_get', { module: 'knowledge', articleKey: 'k' }), agentServer, deps);
    assert.ok(r.result.content[0].text.length <= MAX_TEXT_CHARS + 200);
    const r2 = await handleMessage(call('interview_search', { pageSize: 30 }), agentServer, big);
    assert.ok(!r2.result.isError);
  });

  it('validateArgs 校验类型与枚举', () => {
    const s = { type: 'object', properties: { n: { type: 'integer' }, m: { type: 'string', enum: ['a'] } }, required: ['m'] };
    assert.ok(validateArgs(s, {}));
    assert.ok(validateArgs(s, { m: 'b' }));
    assert.ok(validateArgs(s, { m: 'a', n: 1.5 }));
    assert.strictEqual(validateArgs(s, { m: 'a', n: 2 }), null);
  });
});

describe('Agent 工具', () => {
  it('付费课程模块 firstclass 不可经 MCP 读取', async () => {
    const r = await handleMessage(call('knowledge_get', { module: 'firstclass', articleKey: 'x' }), agentServer, agentDeps());
    assert.strictEqual(r.result.isError, true);
  });

  it('检索结果过滤掉白名单外模块', async () => {
    const deps = agentDeps({
      searchContent: async () => [
        { module: 'firstclass', articleKey: 'a', title: 'A', snippet: '', score: 1, filePath: '' },
        { module: 'knowledge', articleKey: 'b', title: 'B', snippet: '', score: 1, filePath: '' },
      ],
    });
    const r = await handleMessage(call('knowledge_search', { query: '闭包' }), agentServer, deps);
    assert.deepStrictEqual(r.result.structuredContent.items.map((x: any) => x.articleKey), ['b']);
  });

  it('目录树瘦身保留结构与 articleKey', () => {
    const t = slimTree([{ label: 'JS', children: [{ key: 'c', label: '闭包', isLeaf: true, filePath: 'x' }] }]);
    assert.deepStrictEqual(t, [{ title: 'JS', children: [{ title: '闭包', articleKey: 'c' }] }]);
  });

  it('题卡不存在时报错', async () => {
    const r = await handleMessage(call('mission_get', { slug: 'x' }), agentServer, agentDeps());
    assert.strictEqual(r.result.isError, true);
  });
});

describe('Invest 工具（安全字段投影）', () => {
  it('market_snapshot 不透出买卖线、状态、持仓、成本', async () => {
    const r = await handleMessage(call('market_snapshot'), investServer, investDeps());
    const text = r.result.content[0].text;
    for (const banned of ['buy_line', 'sell_line', 'state', 'shares', 'mkt_value', 'cost_price', '510300', 'raw']) {
      assert.ok(!text.includes(banned), `不应出现 ${banned}`);
    }
    const leg = r.result.structuredContent.broad_index_position.items[0];
    assert.strictEqual(leg.long_term_median, 3600);
    assert.strictEqual(leg.vs_median_pct, 11.11);
    assert.ok(r.result.structuredContent.disclaimer);
  });

  it('上游某块失败不拖垮整张快照', async () => {
    const r = await handleMessage(call('market_snapshot'), investServer, investDeps({ bias: async () => { throw new Error('x'); } }));
    assert.ok(!r.result.isError);
    assert.deepStrictEqual(r.result.structuredContent.bias60.items, []);
  });

  it('fear_series 拒绝非法日期', async () => {
    const r = await handleMessage(call('fear_series', { start: '2026-1-1' }), investServer, investDeps());
    assert.strictEqual(r.result.isError, true);
  });

  it('口径文档不含内部编号与买卖倍数', () => {
    const text = JSON.stringify(METHODOLOGY);
    assert.ok(!/\b[PE]\d{1,3}\b/.test(text), '不应出现 P/E 编号');
    assert.ok(!/×1\.\d/.test(text), '不应出现买卖闸倍数');
  });
});

describe('API Key 与存储', () => {
  it('Key 生成、提取与哈希', () => {
    const k = generateKey();
    assert.ok(k.startsWith('jk_') && k.length > 20);
    assert.strictEqual(extractKey({ authorization: `Bearer ${k}` }), k);
    assert.strictEqual(extractKey({ 'x-api-key': k }), k);
    assert.strictEqual(extractKey({ authorization: 'Bearer abc' }), null);
    assert.strictEqual(hashKey(k).length, 64);
  });

  it('北京时间日切', () => {
    assert.strictEqual(beijingYmd(new Date('2026-10-28T16:30:00Z')), '20261029');
    assert.strictEqual(beijingYmd(new Date('2026-10-28T15:30:00Z')), '20261028');
  });

  it('只存哈希，不存明文', async () => {
    const sqls: any[] = [];
    const store = new McpStore(async (sql, params) => { sqls.push([sql, params]); return []; });
    const { key } = await store.create({ scope: 'agent', owner: 'u' });
    const insert = sqls.find(([s]) => s.startsWith('INSERT INTO mcp_api_key'));
    assert.ok(insert);
    assert.ok(!JSON.stringify(insert[1]).includes(key));
    assert.ok(insert[1].includes(hashKey(key)));
  });

  it('每日额度：超出判 over；Redis 故障放行', async () => {
    const row = { id: 1, daily_limit: 2 } as any;
    let n = 0;
    const store = new McpStore(async () => [], { incr: async () => ++n, expire: async () => 1 });
    assert.strictEqual((await store.countCall(row)).over, false);
    assert.strictEqual((await store.countCall(row)).over, false);
    assert.strictEqual((await store.countCall(row)).over, true);
    const broken = new McpStore(async () => [], { incr: async () => { throw new Error('down'); }, expire: async () => 1 });
    assert.strictEqual((await broken.countCall(row)).over, false);
  });
});

describe('MCP HTTP 适配', () => {
  const ROW: ApiKeyRow = {
    id: 7, key_prefix: 'jk_abc', scope: 'agent', owner: 'u', note: null, status: 'active',
    daily_limit: 1, created_at: '', last_used_at: null,
  };
  const KEY = 'jk_testkey';

  function fakeRuntime(over: Partial<McpRuntime> = {}, used = { n: 0 }) {
    const logs: any[] = [];
    const store: any = {
      findActive: async (k: string) => (k === KEY ? ROW : null),
      countCall: async (row: any) => { used.n++; return { used: used.n, limit: row.daily_limit, over: used.n > row.daily_limit }; },
      log: async (x: any) => { logs.push(x); },
    };
    const rt: McpRuntime = {
      store,
      agentDeps: () => agentDeps(),
      investDeps: () => investDeps(),
      isAdmin: async () => false,
      ...over,
    };
    return { rt, logs };
  }

  async function run(rt: McpRuntime, opts: { method?: string; path?: string; headers?: any; body?: any }) {
    const req: any = { method: opts.method || 'POST', headers: opts.headers || {} };
    const res: any = {
      statusCode: 0, headers: {} as any, body: '',
      setHeader(k: string, v: any) { this.headers[k.toLowerCase()] = v; },
      end(b?: any) { this.body = b ? String(b) : ''; },
    };
    const url = new URL(`http://x${opts.path || '/mcp/agent'}`);
    const raw = opts.body === undefined ? '' : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    await handleMcpHttp(req, res, url, rt, Buffer.from(raw));
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  }

  const auth = { authorization: `Bearer ${KEY}` };

  it('无 Key 401、错 Key 401、未开通产品 403', async () => {
    const { rt } = fakeRuntime();
    assert.strictEqual((await run(rt, { body: call('knowledge_tree', { module: 'knowledge' }) })).status, 401);
    assert.strictEqual((await run(rt, { headers: { authorization: 'Bearer jk_wrong' }, body: {} })).status, 401);
    assert.strictEqual((await run(rt, { path: '/mcp/invest', headers: auth, body: call('market_snapshot') })).status, 403);
  });

  it('GET 返回 405（无状态模式不提供 SSE 流）', async () => {
    const { rt } = fakeRuntime();
    const r = await run(rt, { method: 'GET', headers: auth });
    assert.strictEqual(r.status, 405);
    assert.strictEqual(r.headers.allow, 'POST, OPTIONS');
  });

  it('通知返回 202 空体；坏 JSON 返回 400', async () => {
    const { rt } = fakeRuntime();
    const r = await run(rt, { headers: auth, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.strictEqual(r.status, 202);
    assert.strictEqual((await run(rt, { headers: auth, body: '{bad' })).status, 400);
  });

  it('调用成功并落日志；超出每日额度给 isError', async () => {
    const { rt, logs } = fakeRuntime();
    const ok = await run(rt, { headers: auth, body: call('knowledge_tree', { module: 'knowledge' }) });
    assert.strictEqual(ok.status, 200);
    assert.ok(!ok.json.result.isError);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].keyId, 7);
    const over = await run(rt, { headers: auth, body: call('knowledge_tree', { module: 'knowledge' }) });
    assert.strictEqual(over.json.result.isError, true);
    assert.ok(/上限/.test(over.json.result.content[0].text));
  });

  it('initialize 与 tools/list 不计额度', async () => {
    const used = { n: 0 };
    const { rt } = fakeRuntime({}, used);
    await run(rt, { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
    await run(rt, { headers: auth, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.strictEqual(used.n, 0);
  });

  it('管理端非 admin 一律 401', async () => {
    const { rt } = fakeRuntime();
    const r = await run(rt, { path: '/mcp/admin/keys', method: 'GET' });
    assert.strictEqual(r.status, 401);
  });

  it('管理端发 Key 校验 scope 与 owner', async () => {
    const created: any[] = [];
    const { rt } = fakeRuntime({ isAdmin: async () => true });
    (rt.store as any).create = async (p: any) => { created.push(p); return { key: 'jk_x', ...p }; };
    assert.strictEqual((await run(rt, { path: '/mcp/admin/keys', body: { scope: 'bad', owner: 'u' } })).status, 400);
    assert.strictEqual((await run(rt, { path: '/mcp/admin/keys', body: { scope: 'invest' } })).status, 400);
    const ok = await run(rt, { path: '/mcp/admin/keys', body: { scope: 'invest', owner: '张三' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(created[0].scope, 'invest');
  });
});
