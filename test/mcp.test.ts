import * as assert from 'assert';
import { handleMessage, validateArgs, MAX_TEXT_CHARS } from '../src/mcp/protocol';
import { cleanQuery, fuseHits, agentServer, AgentDeps, slimTree, cleanSnippet, extractQuestions, topicTerms } from '../src/mcp/tools/agent';
import { investServer, InvestDeps, findMacroSeries } from '../src/mcp/tools/invest';
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
    assert.deepStrictEqual(r.result.structuredContent.items.map((x: any) => x.articleKey), []);
    // 导航树里有 b 时才返回（正文库残留的下线文章不返回）
    const deps2 = agentDeps({
      ...deps,
      getNavList: async () => ({ navData: [{ key: 'b', label: 'B 正式标题', isLeaf: true }] }),
    });
    const r2 = await handleMessage(call('knowledge_search', { query: '闭包' }), agentServer, deps2);
    assert.deepStrictEqual(r2.result.structuredContent.items.map((x: any) => x.articleKey), ['b']);
    assert.strictEqual(r2.result.structuredContent.items[0].title, 'B 正式标题');
  });

  it('检索：标题命中与正文命中融合，两路都中的排最前；虚词不参与', async () => {
    const nav = [
      { label: 'TypeScript', children: [{ key: 'ts-generics', label: 'TypeScript 泛型', isLeaf: true }] },
      { label: '其他', children: [
        { key: 'ws-sse', label: 'WebSocket 与 SSE 的区别', isLeaf: true },
        { key: 'db', label: '数据库', isLeaf: true },
      ] },
    ];
    const seen: string[] = [];
    const deps = agentDeps({
      getNavList: async () => ({ navData: nav }),
      retrieve: async q => { seen.push(q); return [{ module: 'knowledge', articleKey: 'ts-generics', title: 'x', score: 6 }]; },
      searchContent: async () => [
        { module: 'knowledge', articleKey: 'db', title: '', snippet: '…泛型…', score: 3 },
        { module: 'knowledge', articleKey: 'ts-generics', title: '', snippet: '…', score: 2 },
      ],
    });
    const r = await handleMessage(call('knowledge_search', { query: 'TypeScript 泛型的区别是什么' }), agentServer, deps);
    const items = r.result.structuredContent.items;
    assert.strictEqual(items[0].articleKey, 'ts-generics');
    assert.strictEqual(items[0].title, 'TypeScript 泛型');
    assert.strictEqual(items[0].path, 'TypeScript');
    assert.ok(!/区别|是什么/.test(seen[0]));
    assert.strictEqual(cleanQuery('区别'), '区别');
  });

  it('fuseHits：单字级的弱标题命中不参与', () => {
    const out = fuseHits(
      [{ module: 'k', articleKey: 'weak', score: 0.5 }],
      [{ module: 'k', articleKey: 'body', snippet: 's' }],
      5
    );
    assert.deepStrictEqual(out.map(x => x.articleKey), ['body']);
  });

  it('检索无结果时提示如实说明未覆盖', async () => {
    const deps = agentDeps({ searchContent: async () => [], retrieve: async () => [] });
    const r = await handleMessage(call('knowledge_search', { query: 'Vue3 响应式' }), agentServer, deps);
    assert.deepStrictEqual(r.result.structuredContent.items, []);
    assert.ok(/未覆盖/.test(r.result.structuredContent.note));
  });

  it('面经检索走面经题解目录：按公司路径命中，interview_get 按 articleKey 读', async () => {
    const nav = [{ label: '美团', children: [{ label: '北斗大模型', children: [{ key: 'meituan-1', label: '美团大模型一面', isLeaf: true }] }] }];
    const deps = agentDeps({
      getNavList: async () => ({ navData: nav }),
      retrieve: async (_q, o) => (o.module === 'interview' ? [{ module: 'interview', articleKey: 'meituan-1', title: '', score: 4 }] : []),
      searchContent: async () => [],
      getContent: async (m, k) => ({ module: m, articleKey: k, title: '', content: '## 一面' }),
    });
    const r = await handleMessage(call('interview_search', { keyword: '美团' }), agentServer, deps);
    const it0 = r.result.structuredContent.items[0];
    assert.strictEqual(it0.articleKey, 'meituan-1');
    assert.strictEqual(it0.company, '美团 / 北斗大模型');
    const g = await handleMessage(call('interview_get', { articleKey: 'meituan-1' }), agentServer, deps);
    assert.strictEqual(g.result.structuredContent.title, '美团大模型一面');
    assert.ok(g.result.structuredContent.content.includes('一面'));
  });

  it('片段去掉网页标签与半截标签', () => {
    assert.strictEqual(
      cleanSnippet('…y="agent-role"> <summary>（2）怎样理解全栈？</summary> </details> 全栈要贯通…'),
      '…（2）怎样理解全栈？ 全栈要贯通…'
    );
    assert.strictEqual(cleanSnippet('a &gt; 10 且 <b>b</b>=1 <deta'), 'a > 10 且 b =1');
  });

  it('面经题目抽取：跳过背景学习入口，去掉序号与复习入口前缀', () => {
    const c = [
      '<details data-knowledge-key="promise">\n<summary>（5）手写并发调度器</summary>\n</details>',
      '<details data-knowledge-key="sql">\n<summary>（9）背景学习入口（批处理，不计专题频次）：原问为 SQL</summary></details>',
      '<details data-knowledge-key="redis">\n<summary>（12）同一原问的复习入口（Redis）：轮播最近 20 条怎么存？</summary></details>',
    ].join('\n');
    assert.deepStrictEqual(extractQuestions(c), [
      { key: 'promise', question: '手写并发调度器' },
      { key: 'redis', question: '轮播最近 20 条怎么存？' },
    ]);
    assert.deepStrictEqual(topicTerms('字节全栈岗位最喜欢问哪些问题'), ['字节全栈']);
  });

  it('interview_topics 按公司岗位统计考点：连写词拆公司名，只算匹配的面经，同篇只计一次', async () => {
    const nav = [
      { label: '字节跳动', children: [{ label: '飞书', children: [
        { key: 'b1', label: '字节全栈一面', isLeaf: true },
        { key: 'b2', label: '字节全栈二面', isLeaf: true },
        { key: 'b3', label: '字节算法一面', isLeaf: true },
      ] }] },
      { label: 'OPPO', children: [{ key: 'o1', label: 'OPPO 全栈一面', isLeaf: true }] },
    ];
    const knav = [{ label: '异步', children: [{ key: 'promise', label: 'Promise 与并发控制', isLeaf: true }] }];
    const q = (k: string, t: string) => `<details data-knowledge-key="${k}">\n<summary>${t}</summary>\n</details>`;
    const content: Record<string, string> = {
      b1: q('promise', '（1）手写调度器') + q('promise', '（2）add 返回 Promise') + q('mysql', '（3）联合索引'),
      b2: q('promise', '（1）并发上限 2'),
      b3: q('mysql', '（1）不该被统计'),
      o1: q('mysql', '（1）不该被统计'),
    };
    const fetched: string[] = [];
    const deps = agentDeps({
      getNavList: async m => ({ navData: m === 'knowledge' ? knav : nav }),
      getContent: async (m, k) => { fetched.push(k); return { module: m, articleKey: k, content: content[k] }; },
    });
    const r = await handleMessage(call('interview_topics', { keyword: '字节全栈最喜欢问哪些问题' }), agentServer, deps);
    const sc = r.result.structuredContent;
    assert.deepStrictEqual(fetched.sort(), ['b1', 'b2']);
    assert.strictEqual(sc.articlesAnalyzed, 2);
    assert.strictEqual(sc.topics[0].knowledgeKey, 'promise');
    assert.strictEqual(sc.topics[0].topic, 'Promise 与并发控制');
    assert.strictEqual(sc.topics[0].share, '2/2');
    assert.strictEqual(sc.topics[0].examples.length, 2);
    assert.ok(sc.topics[0].learnUrl.includes('promise'));
    assert.strictEqual(sc.topics[1].share, '1/2');
    const none = await handleMessage(
      call('interview_topics', { keyword: '不存在的公司' }),
      agentServer,
      agentDeps({ getNavList: async () => ({ navData: nav }), searchContent: async () => [], retrieve: async () => [] })
    );
    assert.strictEqual(none.result.structuredContent.articlesAnalyzed, 0);
    assert.ok(/暂无/.test(none.result.structuredContent.note));
  });

  it('题卡与自测题为空时给出替代建议', async () => {
    const m = await handleMessage(call('mission_list'), agentServer, agentDeps());
    assert.ok(m.result.structuredContent.note);
    const q = await handleMessage(call('quiz_get', { module: 'knowledge', articleKey: 'closure' }), agentServer, agentDeps());
    assert.ok(q.result.structuredContent.note);
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

  it('宏观序列可按中文关键词找，返回中文名', async () => {
    assert.ok(findMacroSeries('M2').includes('cn_m.m2_yoy'));
    assert.ok(findMacroSeries('10 年期国债').includes('em_treasury.cn10y'));
    assert.ok(findMacroSeries('制造业 PMI').includes('cn_pmi.pmi010000'));
    const deps = investDeps({
      macro: async () => ({ latest: [
        { series: 'cn_m.m2_yoy', period: '202609', value: 7.2, freq: 'M' },
        { series: 'cn_pmi.pmi010000', period: '202609', value: 50.1, freq: 'M' },
        { series: 'us_tycr.m2', period: '20261023', value: 4.16, freq: 'D' },
      ] }),
    });
    const r = await handleMessage(call('macro_series', { keyword: 'M2' }), investServer, deps);
    assert.deepStrictEqual(r.result.structuredContent.latest.map((x: any) => x.label), ['M2 同比（%）']);
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

function fakeBilling(points = 10, tier: any = 'free') {
  const state = { points, charges: [] as any[], refunds: [] as any[], orders: [] as any[] };
  const b: any = {
    state,
    getAccount: async () => ({ user_id: 'u1', points: state.points, tier, active: tier !== 'free', tier_expire_at: null, next_grant_at: null, monthly_points: 0 }),
    charge: async (_u: string, cost: number, tool: string) => {
      if (state.points < cost) return null;
      state.points -= cost;
      state.charges.push(tool);
      return state.points;
    },
    refund: async (_u: string, cost: number, tool: string) => {
      state.points += cost;
      state.refunds.push(tool);
    },
    activate: async () => ({ created: true }),
    ledgerOf: async () => [],
    ordersOf: async () => [],
    createOrder: async (_u: string, sku: any) => ({ order_no: 'MJ20261030ABCDEF12', sku: sku.sku, amount_cents: sku.priceCents, status: 'pending' }),
  };
  return b;
}

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
      billing: fakeBilling(),
      userIdOf: async () => null,
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

  describe('自助 Key 扣点', () => {
    const USER_ROW = { ...ROW, scope: 'all' as any, user_id: 'u1', daily_limit: 100 };
    function userRt(points: number) {
      const billing = fakeBilling(points);
      const store: any = {
        findActive: async (k: string) => (k === KEY ? USER_ROW : null),
        countCall: async (_r: any, _n: any, limit?: number) => ({ used: 1, limit, over: false }),
        log: async () => {},
      };
      const rt: McpRuntime = {
        store, billing, agentDeps: () => agentDeps(), investDeps: () => investDeps(),
        isAdmin: async () => false, userIdOf: async () => null,
      };
      return { rt, billing };
    }

    it('按工具单价扣点', async () => {
      const { rt, billing } = userRt(10);
      const r = await run(rt, { path: '/mcp/invest', headers: auth, body: call('market_snapshot') });
      assert.ok(!r.json.result.isError);
      assert.strictEqual(billing.state.points, 8);
    });

    it('余额不足拒绝调用并给购买指引，不执行工具', async () => {
      const { rt, billing } = userRt(1);
      const r = await run(rt, { path: '/mcp/invest', headers: auth, body: call('market_snapshot') });
      assert.strictEqual(r.json.result.isError, true);
      assert.ok(/点不足/.test(r.json.result.content[0].text));
      assert.strictEqual(billing.state.points, 1);
    });

    it('工具失败退点；免费工具不扣点；未知工具不扣点', async () => {
      const { rt, billing } = userRt(10);
      await run(rt, { path: '/mcp/invest', headers: auth, body: call('fear_series', { start: 'bad' }) });
      assert.strictEqual(billing.state.points, 10);
      assert.deepStrictEqual(billing.state.refunds, ['fear_series']);
      await run(rt, { path: '/mcp/invest', headers: auth, body: call('methodology_get', { topic: 'fear_index' }) });
      await run(rt, { path: '/mcp/invest', headers: auth, body: call('nope') });
      assert.strictEqual(billing.state.points, 10);
    });

    it('管理员手发的 Key 不扣点', async () => {
      const { rt, logs } = fakeRuntime();
      (rt as any).billing.charge = async () => { throw new Error('不应扣点'); };
      const r = await run(rt, { headers: auth, body: call('knowledge_tree', { module: 'knowledge' }) });
      assert.ok(!r.json.result.isError);
      assert.strictEqual(logs.length, 1);
    });
  });

  describe('自助后台', () => {
    it('价目表公开可读', async () => {
      const { rt } = fakeRuntime();
      const r = await run(rt, { path: '/mcp/pricing', method: 'GET' });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.data.skus.length >= 5);
      assert.ok(r.json.data.skus.every((s: any) => s.price <= s.listPrice));
    });

    it('未登录 401', async () => {
      const { rt } = fakeRuntime();
      assert.strictEqual((await run(rt, { path: '/mcp/me', method: 'GET' })).status, 401);
    });

    it('下单返回收款码与备注码；未知商品 400', async () => {
      const { rt } = fakeRuntime({ userIdOf: async () => 'u1' });
      const bad = await run(rt, { path: '/mcp/me/orders', body: { sku: 'nope' } });
      assert.strictEqual(bad.status, 400);
      const ok = await run(rt, { path: '/mcp/me/orders', body: { sku: 'pro_month' } });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.data.payCode, 'DEF12'.padStart(6, 'C'));
      assert.ok(ok.json.data.qr.endsWith('payment.png'));
    });

    it('Key 数量受档位限制', async () => {
      const { rt } = fakeRuntime({ userIdOf: async () => 'u1' });
      (rt.store as any).countActiveByUser = async () => 1;
      const r = await run(rt, { path: '/mcp/me/keys', body: { name: 'x' } });
      assert.strictEqual(r.status, 400);
      assert.ok(/最多 1 个/.test(r.json.message));
    });
  });
});

