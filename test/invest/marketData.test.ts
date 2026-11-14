import * as assert from 'assert';
import {
  marketSentiment,
  sectorRank,
  sectorHistory,
  indexHistory,
  indexMetrics,
  UNIVERSE_INDEXES,
  backtestSummary,
  clearMarketDataCache,
} from '../../src/service/invest/marketData';
import { investTools } from '../../src/mcp/tools/invest';
import { PRODUCT_TOOLS, TOOL_COST, isDayPassTool } from '../../src/mcp/billing';

/** Skill 第二批数据（2026-11-05）：假库按 SQL 片段路由。 */
class FakeDb {
  calls: { sql: string; params: any[] }[] = [];
  constructor(public d: any) {}
  async q(sql: string, params: any[] = []) {
    this.calls.push({ sql, params });
    const d = this.d;
    if (sql.includes('FROM market_sentiment_daily')) return [...d.sent].sort((a: any, b: any) => (a.trade_date < b.trade_date ? 1 : -1)).slice(0, params[0]);
    if (sql.includes('FROM money_effect_daily')) return d.eff.filter((e: any) => e.trade_date >= params[0]);
    if (sql.includes('MAX(trade_date) d FROM ths_index_daily')) return [{ d: d.thsLatest }];
    if (sql.includes('FROM trade_calendar')) return d.cal.filter((c: string) => c <= params[0]).sort().reverse().slice(0, params[1]).map((c: string) => ({ cal_date: c }));
    if (sql.includes('JOIN ths_index_catalog')) {
      return d.ths.filter((r: any) => d.cat[r.thscode]?.tag === params[0] && (r.trade_date === params[1] || r.trade_date === params[2])).map((r: any) => ({ ...r, name: d.cat[r.thscode].name }));
    }
    if (sql.includes('FROM ths_index_catalog WHERE name LIKE')) {
      const kw = params[0].replace(/%/g, '');
      return Object.entries(d.cat).filter(([, c]: any) => c.name.includes(kw)).map(([k, c]: any) => ({ thscode: k, ...c })).sort((a: any, b: any) => a.name.length - b.name.length);
    }
    if (sql.includes('FROM ths_index_daily WHERE thscode')) return d.ths.filter((r: any) => r.thscode === params[0]).sort((a: any, b: any) => (a.trade_date < b.trade_date ? 1 : -1)).slice(0, params[1]);
    if (sql.includes('JOIN (SELECT code, MAX(trade_date) d FROM index_metrics_daily')) return d.metLatest;
    if (sql.includes('FROM index_metrics_daily m WHERE m.code')) return d.metSeries.filter((r: any) => r.code === params[0]).slice(0, params[1]);
    if (sql.includes('FROM index_daily')) return d.idx.filter((r: any) => r.code === params[0] && r.trade_date >= params[1] && r.trade_date <= params[2]);
    throw new Error(`unexpected sql: ${sql}`);
  }
  async one(sql: string, params: any[] = []) {
    const r = await this.q(sql, params);
    return r[0] ?? null;
  }
}

const data = {
  sent: [
    { trade_date: '20261103', limit_up_cnt: 52, limit_down_cnt: 17, limit_break_cnt: 34, max_board: 4, board2_cnt: 15, board3p_cnt: 3 },
    { trade_date: '20261104', limit_up_cnt: 119, limit_down_cnt: 10, limit_break_cnt: 33, max_board: 3, board2_cnt: 6, board3p_cnt: 7 },
  ],
  eff: [{ trade_date: '20261104', yest_pool_n: 52, yest_pool_ret: -0.001407, yest_pool_open_ret: 0.018517 }],
  thsLatest: '20261104',
  cal: ['20261029', '20261030', '20261102', '20261103', '20261104'],
  cat: {
    '881121.TI': { name: '半导体', tag: 'industry' },
    '881100.TI': { name: '银行', tag: 'industry' },
    '885001.TI': { name: '半导体概念', tag: 'cn_concept' },
  },
  ths: [
    { thscode: '881121.TI', trade_date: '20261029', close: 100, turnover: 5e10 },
    { thscode: '881121.TI', trade_date: '20261104', close: 110, turnover: 6e10 },
    { thscode: '881100.TI', trade_date: '20261029', close: 200, turnover: 1e10 },
    { thscode: '881100.TI', trade_date: '20261104', close: 190, turnover: 1.2e10 },
    { thscode: '885001.TI', trade_date: '20261104', close: 50, turnover: 1e9 },
  ],
  idx: [
    { code: '000300.SH', trade_date: '20261104', open: 1, high: 2, low: 0.5, close: 1.5, pct_chg: 0.42, amount: 345678901.2 },
  ],
};

describe('invest/marketData.ts — Skill 第二批数据', () => {
  beforeEach(() => clearMarketDataCache());

  it('涨跌停情绪：按日期升序、封板率＝涨停/(涨停+炸板)、拼上昨日涨停今日表现', async () => {
    const r = await marketSentiment(new FakeDb(data) as any, 20);
    assert.deepStrictEqual(r.rows.map(x => x.trade_date), ['20261103', '20261104']);
    assert.strictEqual(r.rows[1].seal_rate_pct, 78.3);
    assert.deepStrictEqual(r.rows[1].yesterday_limit_up_today, { count: 52, avg_change_pct: -0.14, avg_open_premium_pct: 1.85 });
    assert.strictEqual(r.rows[0].yesterday_limit_up_today, null);
  });

  it('板块排行：按交易日历往前数 period 天、只排同一分类、涨幅榜/跌幅榜、成交额换算亿元', async () => {
    const db = new FakeDb(data) as any;
    const r = await sectorRank(db, { tag: 'industry', period: 4, top: 10 });
    assert.strictEqual(r.from_date, '20261029');
    assert.strictEqual(r.to_date, '20261104');
    assert.deepStrictEqual(r.items.map(i => [i.name, i.change_pct]), [['半导体', 10], ['银行', -5]]);
    assert.strictEqual(r.items[0].turnover_yi, 600);
    const b = await sectorRank(db, { tag: 'industry', period: 4, order: 'bottom', top: 1 });
    assert.deepStrictEqual(b.items.map(i => i.name), ['银行']);
    // 非法分类回退行业，period/top 有上下限
    const x = await sectorRank(db, { tag: 'drop table', period: 9999, top: -3 });
    assert.strictEqual(x.category, '行业');
    assert.strictEqual(x.items.length, 0, '日历不够长没有基准日就不排');
  });

  it('单个板块走势：关键词取名称最短的那个，其余列 other_matches', async () => {
    const r: any = await sectorHistory(new FakeDb(data) as any, { keyword: '半导体', days: 10 });
    assert.strictEqual(r.sector.name, '半导体');
    assert.strictEqual(r.sector.category, '行业');
    assert.deepStrictEqual(r.other_matches.map((m: any) => m.category), ['概念']);
    assert.deepStrictEqual(r.rows.map((x: any) => x.trade_date), ['20261029', '20261104']);
    const none: any = await sectorHistory(new FakeDb(data) as any, { keyword: '%%' });
    assert.deepStrictEqual(none.matches, []);
  });

  it('指数日线：只开每日更新的指数，成交额千元→亿元', async () => {
    const r: any = await indexHistory(new FakeDb(data) as any, { code: '000300.sh', start: '20261101' });
    assert.strictEqual(r.name, '沪深300');
    assert.strictEqual(r.rows[0].amount_yi, 3456.79);
    const bad: any = await indexHistory(new FakeDb(data) as any, { code: '399999.SZ' });
    assert.strictEqual(bad.error, 'unknown_code', '名单外的代码不开');
    // 2026-11-14 常见指数全集并入（深证成指已日更）
    const sz: any = await indexHistory(new FakeDb(data) as any, { code: '399001.SZ', start: '20261101' });
    assert.strictEqual(sz.name, '深证成指');
  });

  it('常见指数统一读数：按名单顺序、可按类别过滤、不下发买卖参考线', async () => {
    const row = (code: string, name: string, category: string, d = '20261113') => ({
      trade_date: d, code, name, category, close: '100', n_hist: 600, median_all: '80', pos_ratio: '1.25',
      median_5y: '90', pos_5y: '1.111111', peak: '120', dd_peak: '-0.166667', ma60: '105', bias60: '-0.047619',
      bias_win: 2500, bias_rank_low: 12, bias_rank_high: 2489, bias_extreme: '', bias_pct_all: '0.05', bias_rank_all: 30,
      buy_line: '80', sell_line: '104',
    });
    const db = new FakeDb({
      metLatest: [row('HSI.HI', '恒生指数', '港股海外'), row('399997.SZ', '中证白酒', '行业主题', '20261111'),
                  row('000300.SH', '沪深300', '宽基'), row('XXX.SH', '名单外', '宽基')],
      metSeries: [row('399997.SZ', '中证白酒', '行业主题', '20261111'), row('399997.SZ', '中证白酒', '行业主题', '20261110')],
    });
    const all: any = await indexMetrics(db as any, {});
    assert.deepStrictEqual(all.latest.map((r: any) => r.code), ['000300.SH', '399997.SZ', 'HSI.HI']);
    assert.strictEqual(all.as_of, '20261113');
    assert.strictEqual(all.latest[0].drawdown_from_peak_pct, -16.67);
    assert.strictEqual(all.latest[0].bias60_pct, -4.76);
    assert.ok(!JSON.stringify(all).includes('buy_line') && !JSON.stringify(all).includes('sell_line'));
    const cat: any = await indexMetrics(db as any, { category: '行业主题' });
    assert.deepStrictEqual(cat.latest.map((r: any) => r.code), ['399997.SZ']);
    const one: any = await indexMetrics(db as any, { code: '399997.sz', days: 5 });
    assert.deepStrictEqual(one.rows.map((r: any) => r.trade_date), ['20261110', '20261111']);
    const bad: any = await indexMetrics(db as any, { code: 'FOO' });
    assert.strictEqual(bad.error, 'unknown_code');
    assert.strictEqual(UNIVERSE_INDEXES.length, 41);
  });

  it('回测成绩：四个指数按全站顺序，逐年复利汇总，不带买卖线与成交明细', () => {
    const legs = backtestSummary({
      legs: [
        { name: '红利', ann: 0.05, monthly: [], trades: [{ price: 1 }], buy_line: [1] },
        {
          name: '沪深300', start: '20070508', end: '20261104', ann: 0.075265, bh_ann: 0.005492, cum: 4.1148, mdd: -0.3733, n_buy: 48, n_sell: 70, pos_avg: 0.6339,
          monthly: [{ ym: '200705', r: 0.1, bh: 0.1 }, { ym: '200706', r: 0.1, bh: -0.1 }, { ym: '200801', r: -0.05, bh: 0 }],
          trades: [{ price: 1 }], buy_line: [1], sell_line: [1],
        },
      ],
    });
    assert.deepStrictEqual(legs.map(l => l.index), ['沪深300', '中证红利']);
    assert.strictEqual(legs[0].rule_annual_return_pct, 7.53);
    assert.strictEqual(legs[0].rule_max_drawdown_pct, -37.33);
    assert.deepStrictEqual(legs[0].yearly, [
      { year: '2007', rule_return_pct: 21, buy_hold_return_pct: -1 },
      { year: '2008', rule_return_pct: -5, buy_hold_return_pct: 0 },
    ]);
    const s = JSON.stringify(legs);
    assert.ok(!s.includes('trades') && !s.includes('buy_line') && !s.includes('sell_line'));
  });

  it('工具清单、价目、当天只扣一次三处一致；回测成绩免费', () => {
    const names = investTools.map(t => t.name);
    for (const t of ['market_sentiment', 'sector_rank', 'sector_history', 'index_history', 'rule_backtest']) {
      assert.ok(names.includes(t), t);
      assert.ok(PRODUCT_TOOLS.invest.includes(t), t);
      assert.ok(t in TOOL_COST, t);
    }
    assert.strictEqual(TOOL_COST.rule_backtest, 0);
    assert.ok(isDayPassTool('index_history') && isDayPassTool('sector_history') && isDayPassTool('market_sentiment'));
    assert.ok(!isDayPassTool('sector_rank'));
  });
});
