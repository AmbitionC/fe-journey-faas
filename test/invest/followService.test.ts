import * as assert from 'assert';
import { InvestFollowService } from '../../src/service/invest/follow';
import { combineCurves } from '../../src/service/invest/followCalc';

/**
 * 跟车服务层（2026-11-02）：假库按 SQL 片段路由，验证
 *  - 非会员只拿到市场级 + 方向，不拿比例/金额/账本；
 *  - 会员：同日多条信号按顺序串联换算（抢买先扣现金、锚买按剩余现金）；净值＝现金+份额×最新收盘；
 *  - 档案：本金下限、起步日不早于今天、改本金须确认重开账本；
 *  - 记账修改：只改自己的、edited 重算金额、auto 回到自动值；
 *  - 非会员信号流只看 30 天前的历史。
 */
class FakeDb {
  execs: { sql: string; params: any[] }[] = [];
  constructor(public data: any) {}
  async q(sql: string, params: any[] = []) {
    const d = this.data;
    if (sql.includes('MAX(trade_date) d FROM broad_leg_state')) return [{ d: d.stateDate }];
    if (sql.includes('FROM broad_leg_state WHERE trade_date')) return d.legs || [];
    if (sql.includes('MAX(signal_date) d FROM broad_signal')) return [{ d: d.sigDate }];
    if (sql.includes('FROM broad_signal WHERE signal_date')) return d.today || [];
    if (sql.includes('FROM broad_signal WHERE exec_date <')) return (d.hist || []).filter((r: any) => r.exec_date < params[0]);
    if (sql.includes("WHERE side = 'buy' AND engine_fired = 1")) {
      return (d.hist || []).filter((r: any) => r.side === 'buy' && r.engine_fired).sort((a: any, b: any) => (a.signal_date < b.signal_date ? 1 : -1));
    }
    if (sql.includes('FROM broad_signal ORDER BY')) return d.hist || [];
    if (sql.includes('FROM trade_calendar')) return (d.cal || []).map((c: string) => ({ cal_date: c }));
    if (sql.includes('FROM broad_strategy_stats')) return d.stats || [];
    if (sql.includes('SELECT fee_rate, min_fee FROM user_follow_profile')) {
      const p = (d.profile || []).find((x: any) => x.leg === params[1]);
      return p ? [p] : [];
    }
    if (sql.includes('FROM user_follow_profile WHERE user_id = ? AND leg')) {
      const p = (d.profile || []).find((x: any) => x.leg === params[1]);
      return p ? [p] : [];
    }
    if (sql.includes('FROM user_follow_profile WHERE user_id')) return d.profile || [];
    if (sql.includes('COUNT(*) n FROM user_follow_exec')) return [{ n: (d.exec || []).filter((r: any) => r.leg === params[1]).length }];
    if (sql.includes('FROM user_follow_exec WHERE id = ? AND user_id')) {
      const r = (d.exec || []).find((x: any) => x.id === params[0] && x.user_id === params[1]);
      return r ? [r] : [];
    }
    if (sql.includes('FROM user_follow_exec WHERE user_id = ? AND leg = ? ORDER BY')) {
      return (d.exec || []).filter((r: any) => r.leg === params[1]);
    }
    if (sql.includes('FROM user_follow_exec WHERE user_id')) return d.exec || [];
    if (sql.includes('SELECT id, flow_date FROM user_follow_cashflow WHERE id')) {
      const f = (d.flows || []).find((x: any) => x.id === params[0] && x.leg === params[2]);
      return f ? [f] : [];
    }
    if (sql.includes('FROM user_follow_cashflow WHERE user_id = ? AND leg = ?')) {
      return (d.flows || []).filter((x: any) => x.leg === params[1]);
    }
    if (sql.includes('FROM user_follow_cashflow WHERE user_id')) return d.flows || [];
    if (sql.includes('FROM stock_daily WHERE code = ? AND trade_date >= ?')) {
      return (d.closes?.[params[0]] || []).filter((r: any) => r.trade_date >= params[1] && r.trade_date <= params[2]);
    }
    if (sql.includes('FROM stock_daily WHERE code = ? AND trade_date <= ?')) {
      const rows = (d.closes?.[params[0]] || []).filter((r: any) => r.trade_date <= params[1]);
      return rows.length ? [rows[rows.length - 1]] : [];
    }
    throw new Error(`unexpected sql: ${sql}`);
  }
  async one(sql: string, params: any[] = []) {
    const rows = await this.q(sql, params);
    return rows.length ? rows[0] : null;
  }
  async exec(sql: string, params: any[] = []) {
    this.execs.push({ sql, params });
  }
}

const svc = (data: any) => {
  const s = new InvestFollowService();
  const db = new FakeDb(data);
  (s as any).db = db;
  return { s, db };
};

const market = {
  stateDate: '20261030',
  sigDate: '20261030',
  cal: ['20261030', '20261102', '20261103', '20261104', '20261105', '20261106', '20261109', '20261130', '20261201'],
  legs: [
    { trade_date: '20261030', leg: '沪深300', etf: '510300.SH', close: 4600, median: 3800, buy_line: 3800, sell_line: 4940, state: 'hold', fear: 40, data_date: '20261030' },
    { trade_date: '20261030', leg: '红利', etf: '515080.SH', close: 6000, median: 4000, buy_line: 4000, sell_line: 5200, state: 'sell', fear: 40, data_date: '20261030' },
  ],
  today: [
    { signal_date: '20261030', leg: '沪深300', kind: 'panic_buy', seq: 0, exec_date: '20261102', etf: '510300.SH', side: 'buy', frac: 0.5, why: '恐慌 80', close: 4600, fear: 80, ref_line: 4700, engine_fired: 1 },
    { signal_date: '20261030', leg: '沪深300', kind: 'anchor_buy', seq: 1, exec_date: '20261102', etf: '510300.SH', side: 'buy', frac: 0.2, why: '低于买入线', close: 4600, fear: 80, ref_line: 4700, engine_fired: 1 },
    { signal_date: '20261030', leg: '红利', kind: 'sell', seq: 0, exec_date: '20261102', etf: '515080.SH', side: 'sell', frac: 0.05, why: '高于卖出线', close: 6000, fear: 80, ref_line: 5200, engine_fired: 1 },
  ],
};

describe('invest/follow.ts — 跟车服务层', () => {
  it('非会员：只给方向，不给比例/金额/账本；下一检查日按交易日历', async () => {
    const { s } = svc({ ...market });
    const r = await s.overview('u1', false, null);
    assert.strictEqual(r.member, false);
    assert.strictEqual(r.legs.length, 0);
    assert.strictEqual(r.profile, null);
    assert.strictEqual(r.market.today.length, 3);
    assert.ok(!('frac' in r.market.today[0]), '非会员不应拿到比例');
    assert.strictEqual((r.market.today[0] as any).side, 'buy');
    assert.strictEqual(r.market.exec_date, '20261102');
    // 10-30 是周五（下一交易日 11-02 跨周）、也是月末（下一交易日跨月）
    assert.deepStrictEqual(r.market.next_check, { week_end: '20261030', month_end: '20261030' });
    assert.strictEqual(r.market.legs[0].leg, '沪深300');
  });

  it('market.last_buy：每腿取最近一次真触发的买入信号，非会员也可见', async () => {
    const hist = [
      { leg: '沪深300', kind: 'anchor_buy', signal_date: '20240105', exec_date: '20240108', side: 'buy', engine_fired: 1 },
      { leg: '沪深300', kind: 'panic_buy', signal_date: '20250407', exec_date: '20250408', side: 'buy', engine_fired: 1 },
      { leg: '沪深300', kind: 'sell', signal_date: '20250430', exec_date: '20250506', side: 'sell', engine_fired: 1 },
      { leg: '红利', kind: 'sell', signal_date: '20250929', exec_date: '20250930', side: 'sell', engine_fired: 0 },
    ];
    const { s } = svc({ ...market, hist });
    const r = await s.overview('u1', false, null);
    const lb = (r.market as any).last_buy;
    assert.strictEqual(lb['沪深300'].signal_date, '20250407');
    assert.strictEqual(lb['沪深300'].kind, 'panic_buy');
    assert.strictEqual(lb['沪深300'].kind_cn, '恐慌抢买');
    assert.strictEqual(lb['红利'], undefined, '未真触发的卖出不算');
  });

  it('会员：同日两条买入按顺序串联换算；净值与基准分开汇总；已记账的不再出现在待执行', async () => {
    const data = {
      ...market,
      profile: [
        { leg: '沪深300', principal: 100000, start_date: '20261001', status: 'active' },
        { leg: '红利', principal: 50000, start_date: '20261001', status: 'active' },
      ],
      exec: [
        // 红利：此前买过 10000 份（基准 10000，用户实际只买了 9000）
        { id: 1, user_id: 'u1', leg: '红利', signal_date: '20261010', kind: 'anchor_buy', exec_date: '20261013', etf: '515080.SH', side: 'buy', frac: 0.2, price: 1.0, bench_shares: 10000, bench_amount: 10000, shares: 9000, amount: 9000, status: 'edited', note: '' },
      ],
      closes: {
        '510300.SH': [{ trade_date: '20261029', close: 3.9 }, { trade_date: '20261030', close: 4.0 }],
        '515080.SH': [{ trade_date: '20261013', close: 1.0 }, { trade_date: '20261030', close: 1.2 }],
      },
    };
    const { s, db } = svc(data);
    const until = new Date('2027-01-01T00:00:00Z');
    const r = await s.overview('u1', true, until);
    assert.strictEqual(r.member, true);
    const hs = r.legs.find((l: any) => l.leg === '沪深300');
    assert.strictEqual(hs.enabled, true);
    assert.strictEqual(hs.cash, 100000);
    assert.strictEqual(hs.advice.length, 2);
    // 档案没填佣金 ⟹ 默认万3/最低5元。抢买 50%：预算 50000 含佣金 → floor(50000/(4×1.0003)/100)×100
    // = 12400 份 → 49600 元，佣金 14.88；锚买 20% 按扣佣后现金 (100000−49600−14.88)×20% = 10077.02
    // → 2500 份 → 10000 元，佣金 5（与 Python size_order 同一套算术）
    assert.strictEqual(hs.advice[0].shares, 12400);
    assert.strictEqual(hs.advice[0].amount, 49600);
    assert.strictEqual(hs.advice[0].fee, 14.88);
    assert.strictEqual(hs.advice[1].shares, 2500);
    assert.strictEqual(hs.advice[1].amount, 10000);
    assert.strictEqual(hs.advice[1].fee, 5);
    assert.ok(hs.advice[0].text.includes('沪深300ETF（510300） 买入 12,400 份，约 49,600 元，佣金约 14.88 元'), hs.advice[0].text);
    assert.strictEqual(hs.fee_rate, 0.0003);
    assert.strictEqual(hs.min_fee, 5);
    const hl = r.legs.find((l: any) => l.leg === '红利');
    // 实际：现金 41000 + 9000×1.2 = 51800；基准：40000 + 10000×1.2 = 52000
    assert.strictEqual(hl.nav, 51800);
    assert.strictEqual(hl.bench.nav, 52000);
    assert.strictEqual(hl.pnl, 1800);
    // 卖出 5%：9000×0.05=450 → 半数进一 500 份
    assert.strictEqual(hl.advice[0].shares, 500);
    assert.strictEqual(hl.stats.edited, 1);
    assert.strictEqual(r.totals.principal, 150000);
    assert.strictEqual(r.totals.actions_today, 3);
    // 曲线：红利 10-13 起有记账，沪深300 10-29 起有收盘；并集前向填充
    const last = r.curve[r.curve.length - 1];
    assert.strictEqual(last.date, '20261030');
    assert.strictEqual(last.nav, 100000 + 51800);
    assert.strictEqual(last.bench, 100000 + 52000);
    // 未开启的两腿也在列表里（enabled=false），顺序固定
    assert.deepStrictEqual(r.legs.map((l: any) => l.leg), ['沪深300', '红利', '创业板', '科创50']);
    // 会员到期回写档案
    assert.ok(db.execs.some((e) => e.sql.includes('SET member_until')));
  });

  it('档案：本金下限、起步日不早于今天、改本金须确认重开账本、暂停/恢复', async () => {
    const { s, db } = svc({ ...market, profile: [], exec: [] });
    await assert.rejects(() => s.saveProfile('u1', null, { leg: '上证50', principal: 5000 }), /四腿/);
    await assert.rejects(() => s.saveProfile('u1', null, { leg: '沪深300', principal: 500 }), /至少/);
    const r = await s.saveProfile('u1', null, { leg: '沪深300', principal: 50000, start_date: '20200101' });
    assert.ok(r.start_date >= '20261102', '起步日不得早于今天');
    assert.ok(db.execs.some((e) => e.sql.startsWith('INSERT INTO user_follow_profile')));

    const withRows = svc({
      ...market,
      profile: [{ leg: '沪深300', principal: 50000, start_date: '20261001', status: 'active' }],
      exec: [{ id: 1, user_id: 'u1', leg: '沪深300' }],
    });
    await assert.rejects(
      () => withRows.s.saveProfile('u1', null, { leg: '沪深300', principal: 60000, start_date: '20261001' }),
      /重新开始记账/
    );
    const ok = await withRows.s.saveProfile('u1', null, { leg: '沪深300', principal: 60000, start_date: '20261001', confirm_reset: true });
    assert.strictEqual(ok.reset, true);
    assert.ok(withRows.db.execs.some((e) => e.sql.startsWith('DELETE FROM user_follow_exec')));
    // 起步日会被抬到今天（不回溯）
    assert.ok(ok.start_date >= '20261102');
    const p = await withRows.s.saveProfile('u1', null, { leg: '沪深300', action: 'pause' });
    assert.strictEqual(p.status, 'paused');
    // 佣金：范围校验；只改佣金不重开账本
    await assert.rejects(
      () => withRows.s.saveProfile('u1', null, { leg: '沪深300', principal: 60000, start_date: '20261001', fee_rate: 0.01 }),
      /佣金率/
    );
    const f = await withRows.s.saveProfile('u1', null, {
      leg: '沪深300', principal: 60000, start_date: '20261001', fee_rate: 0.0001, min_fee: 0, confirm_reset: true,
    });
    assert.strictEqual(f.fee_rate, 0.0001);
    assert.strictEqual(f.min_fee, 0);
  });

  it('市场级带四腿费前/费后统计与标的信息（库表 JSON 解析）', async () => {
    const { s } = svc({
      ...market,
      stats: [
        { leg: '沪深300', principal: 100000, etf: '510300.SH', start: '20070508', as_of: '20261030', cum: 4.116,
          cum_published: 4.1148, cum_net: 4.01, bh_cum: 1.0812, fees: 1234.5, nb: 52, ns: 70, fee_rate: 0.0003,
          min_fee: 5, expense: 0.002, instrument: '{"name":"沪深300ETF","mgmt":0.0015,"custody":0.0005}' },
      ],
    });
    const r = await s.overview('u1', false, null);
    assert.strictEqual(r.market.stats.length, 1);
    assert.strictEqual(r.market.stats[0].cum_net, 4.01);
    assert.strictEqual(r.market.stats[0].instrument.name, '沪深300ETF');
  });

  it('记账修改：只改自己的；edited 重算金额；auto 回到自动值', async () => {
    const { s, db } = svc({
      ...market,
      exec: [{ id: 7, user_id: 'u1', leg: '沪深300', side: 'buy', price: 4.0, bench_shares: 2500, bench_amount: 10000 }],
      profile: [],
    });
    await assert.rejects(() => s.updateExec('u2', { id: 7, status: 'skipped' }), /不存在/);
    await assert.rejects(() => s.updateExec('u1', { id: 7, status: 'edited', shares: 2550, price: 0 }), /价格/);
    const e = await s.updateExec('u1', { id: 7, status: 'edited', shares: 2400, price: 4.01 });
    assert.strictEqual(e.amount, 9624);
    // 没填佣金 ⟹ 按默认档算：9624×0.0003=2.89 < 5 ⟹ 5
    assert.strictEqual(e.fee, 5);
    const e2 = await s.updateExec('u1', { id: 7, status: 'edited', shares: 2400, price: 4.01, fee: 1.2 });
    assert.strictEqual(e2.fee, 1.2);
    await s.updateExec('u1', { id: 7, status: 'skipped', note: '当天没开盘软件' });
    await s.updateExec('u1', { id: 7, status: 'auto' });
    assert.ok(db.execs[db.execs.length - 1].sql.includes('shares = bench_shares'));
    assert.ok(db.execs.every((x) => x.params.includes('u1')), '每条写都带 user_id');
  });

  it('信号流：非会员只看 30 天前的历史且不带比例', async () => {
    const hist = [
      { signal_date: '20261030', leg: '红利', kind: 'sell', seq: 0, exec_date: '20261102', etf: '515080.SH', side: 'sell', frac: 0.05 },
      { signal_date: '20260901', leg: '沪深300', kind: 'anchor_buy', seq: 0, exec_date: '20260902', etf: '510300.SH', side: 'buy', frac: 0.2 },
    ];
    const { s } = svc({ ...market, hist });
    const m = await s.signals(true, 10);
    assert.strictEqual(m.rows.length, 2);
    assert.strictEqual((m.rows[0] as any).frac, 0.05);
    const n = await s.signals(false, 10);
    assert.strictEqual(n.rows.length, 1);
    assert.strictEqual(n.rows[0].signal_date, '20260901');
    assert.ok(!('frac' in n.rows[0]));
  });

  it('combineCurves：并集日期、前向填充、起步前按本金计', () => {
    const out = combineCurves([
      { principal: 100, series: [{ date: '20260102', nav: 101, bench: 102 }, { date: '20260103', nav: 103, bench: 104 }] },
      { principal: 50, series: [{ date: '20260103', nav: 55, bench: 56 }] },
    ]);
    assert.deepStrictEqual(out, [
      { date: '20260102', nav: 151, bench: 152 },
      { date: '20260103', nav: 158, bench: 160 },
    ]);
  });

  it('资金进出：现金含流水；净投入/收益额/单位净值；取出上限、日期不早于最后记账、删除不改写历史', async () => {
    const data = {
      ...market,
      today: [],
      profile: [{ leg: '沪深300', principal: 100000, start_date: '20261001', status: 'active' }],
      exec: [
        // 10-13 按 20% 买 20000 元（5000 份 @4.0）
        { id: 1, user_id: 'u1', leg: '沪深300', signal_date: '20261010', kind: 'anchor_buy', exec_date: '20261013', etf: '510300.SH', side: 'buy', frac: 0.2, price: 4.0, bench_shares: 5000, bench_amount: 20000, shares: 5000, amount: 20000, status: 'auto', note: '' },
      ],
      flows: [
        { id: 7, user_id: 'u1', leg: '沪深300', flow_date: '20261013', amount: 30000, note: '同日追加' },
        { id: 8, user_id: 'u1', leg: '沪深300', flow_date: '20261020', amount: -10000, note: '取出' },
      ],
      closes: {
        '510300.SH': [
          { trade_date: '20261013', close: 4.0 },
          { trade_date: '20261020', close: 4.4 },
          { trade_date: '20261030', close: 4.4 },
        ],
      },
    };
    const { s, db } = svc(data);
    const r = await s.overview('u1', true, new Date('2027-01-01T00:00:00Z'));
    const hs = r.legs.find((l: any) => l.leg === '沪深300')!;
    // 现金 = 100000 − 20000 + 30000 − 10000 = 100000；净投入 120000；市值 100000 + 5000×4.4 = 122000；收益 2000
    assert.strictEqual(hs.cash, 100000);
    assert.strictEqual(hs.net_in, 120000);
    assert.strictEqual(hs.nav, 122000);
    assert.strictEqual(hs.pnl, 2000);
    // 单位净值：10-13 追加当日先按流入前市值定价（100000/100000=1.0），10-20 市值 132000−… 份额法 = 1.0 + 持仓涨幅贡献
    // 10-13：V=130000，pre=100000 → u=1.0，份额 130000；10-20：V=(80000+30000−10000)+5000×4.4=122000，pre=132000 → u=1.015385，份额 130000−10000/1.015385
    assert.ok(Math.abs(hs.unit_nav - 1.015385) < 1e-5, String(hs.unit_nav));
    assert.strictEqual(r.totals!.net_in, 120000);
    assert.strictEqual(r.totals!.pnl, 2000);
    assert.ok(Math.abs(r.totals!.unit_nav - 1.015385) < 1e-5);
    assert.ok(r.curve.every((c: any) => typeof c.unit === 'number'));
    assert.ok(typeof r.totals!.mwr === 'number');
    // 追加：日期早于最后记账日拒绝；默认今天写入
    await assert.rejects(() => s.cashflow('u1', { leg: '沪深300', amount: 5000, flow_date: '20261010' }), /最后一笔记账日/);
    await assert.rejects(() => s.cashflow('u1', { leg: '沪深300', amount: 0 }), /不能为 0/);
    const ok = await s.cashflow('u1', { leg: '沪深300', amount: 5000 });
    assert.strictEqual(ok.ok, true);
    assert.ok(db.execs.some((e) => e.sql.startsWith('INSERT INTO user_follow_cashflow') && e.params[3] === 5000));
    // 取出：不超过现金（你的现金 100000 / 基准现金 100000）
    await assert.rejects(() => s.cashflow('u1', { leg: '沪深300', amount: -100001 }), /最多可取出 100,000/);
    const w = await s.cashflow('u1', { leg: '沪深300', amount: -100000 });
    assert.strictEqual(w.amount, -100000);
    // 删除：其后已有记账的流水不可删（id 7 日期 10-13 = 最后记账日，允许；若早于则拒）
    const rm = await s.cashflow('u1', { leg: '沪深300', action: 'remove', id: 7 });
    assert.strictEqual(rm.removed, 7);
    const later = svc({ ...data, exec: [...data.exec, { ...data.exec[0], id: 2, signal_date: '20261017', exec_date: '20261020' }] });
    await assert.rejects(() => later.s.cashflow('u1', { leg: '沪深300', action: 'remove', id: 7 }), /不能删除/);
    await assert.rejects(() => s.cashflow('u1', { leg: '红利', amount: 100 }), /尚未开启/);
  });
});
