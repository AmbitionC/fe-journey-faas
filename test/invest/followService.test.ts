import * as assert from 'assert';
import { InvestFollowService } from '../../src/service/invest/follow';
import { combineCurves } from '../../src/service/invest/followCalc';
import { beijingDay } from '../../src/common/signupSite';

/**
 * 跟车服务层（2026-11-02，一个总资金、一个现金池）：假库按 SQL 片段路由，验证
 *  - 非会员只拿到市场级 + 方向，不拿比例/金额/账本；
 *  - 会员：同日多条信号先卖后买、买入按现金池÷4 计量、同指数多笔递减；净值＝现金池+Σ份额×最新收盘；
 *  - 档案：总资金下限、起步日不早于今天、改总资金须确认重开账本（记账与流水一起清）；
 *  - 记账修改：只改自己的、edited 重算金额、auto 回到自动值；
 *  - 资金进出组合级：取出上限取「你的现金池 / 基准现金池」较小值；
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
    if (sql.includes('FROM broad_signal WHERE signal_date')) return (d.today || []).filter((r: any) => r.signal_date === params[0]);
    if (sql.includes('FROM broad_signal WHERE exec_date <')) return (d.hist || []).filter((r: any) => r.exec_date < params[0]);
    if (sql.includes("WHERE side = 'buy' AND engine_fired = 1")) {
      return (d.hist || []).filter((r: any) => r.side === 'buy' && r.engine_fired).sort((a: any, b: any) => (a.signal_date < b.signal_date ? 1 : -1));
    }
    if (sql.includes('FROM broad_signal ORDER BY')) return d.hist || [];
    if (sql.includes('FROM trade_calendar')) return (d.cal || []).map((c: string) => ({ cal_date: c }));
    if (sql.includes('FROM broad_strategy_stats')) return d.stats || [];
    if (sql.includes('FROM user_follow_portfolio WHERE user_id')) return d.profile ? [d.profile] : [];
    if (sql.includes('COUNT(*) n FROM user_follow_exec')) return [{ n: (d.exec || []).length }];
    if (sql.includes('FROM user_follow_exec WHERE id = ? AND user_id')) {
      const r = (d.exec || []).find((x: any) => x.id === params[0] && x.user_id === params[1]);
      return r ? [r] : [];
    }
    if (sql.includes('FROM user_follow_exec WHERE user_id')) return d.exec || [];
    if (sql.includes('SELECT id, flow_date FROM user_follow_cashflow WHERE id')) {
      const f = (d.flows || []).find((x: any) => x.id === params[0]);
      return f ? [f] : [];
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

describe('invest/follow.ts — 跟车服务层（一个总资金）', () => {
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
    // 判定日 10-30 本身的周末/月末检查已经做过（信号已出），「下次」要严格晚于它：11-06 / 11-30
    assert.deepStrictEqual(r.market.next_check, { week_end: '20261106', month_end: '20261130' });
    assert.strictEqual(r.market.legs[0].leg, '沪深300');
  });

  it('判定日取状态表与信号表较新者；没信号的日子不再把最后一次信号当「今天」（2026-11-04 实测缺陷）', async () => {
    // 状态表已到 11-03、信号表最后一行 10-30（11-02/11-03 无信号）
    const { s } = svc({ ...market, stateDate: '20261103', sigDate: '20261030' });
    const r = await s.overview('u1', false, null);
    assert.strictEqual(r.market.date, '20261103');
    assert.strictEqual(r.market.state_date, '20261103');
    assert.strictEqual((r.market as any).signal_date, '20261030');
    assert.strictEqual(r.market.today.length, 0, '10-30 的信号不是 11-03 的「今天」');
    assert.strictEqual(r.market.exec_date, null, '没有信号就没有执行日');
    assert.deepStrictEqual(r.market.next_check, { week_end: '20261106', month_end: '20261130' });
    // 反过来：同一班次信号表先写、状态表还停在前一日 → 以信号表为准
    const r2 = await svc({ ...market, stateDate: '20261029', sigDate: '20261030' }).s.overview('u1', false, null);
    assert.strictEqual(r2.market.date, '20261030');
    assert.strictEqual(r2.market.today.length, 3);
  });

  it('会员：起步日晚于今日信号的执行日 → 给「起步前触发、不补发」说明，不计入今天要做的动作；估值取今天之前最新收盘', async () => {
    const data = {
      ...market,
      profile: { principal: 100000, start_date: '20261103', status: 'active' },
      exec: [],
      closes: {
        // 收盘表比判定日（10-30）新：估值用 11-02 的价
        '510300.SH': [{ trade_date: '20261030', close: 4.065 }, { trade_date: '20261102', close: 4.085 }],
      },
    };
    const r = await svc(data).s.overview('u1', true, null);
    assert.strictEqual(r.totals!.actions_today, 0);
    const hs = r.legs.find((l: any) => l.leg === '沪深300')!;
    assert.strictEqual(hs.advice.length, 2);
    assert.ok(hs.advice.every((a: any) => a.skipped && a.reason === '起步前触发'));
    assert.ok(hs.advice[0].text.includes('2026-11-03 起步之前触发'), hs.advice[0].text);
    assert.ok(hs.advice[0].text.includes('执行日 2026-11-02'), hs.advice[0].text);
    const hl = r.legs.find((l: any) => l.leg === '红利')!;
    assert.strictEqual(hl.advice.length, 1);
    assert.strictEqual(hl.advice[0].reason, '起步前触发');
    assert.deepStrictEqual(hs.price, { close: 4.085, date: '20261102' });
    assert.strictEqual(r.totals!.as_of, '20261102');
    assert.strictEqual(r.totals!.nav, 100000);
    // 暂停：同样给一句话
    const paused = await svc({ ...data, profile: { principal: 100000, start_date: '20261001', status: 'paused' } }).s.overview('u1', true, null);
    assert.strictEqual(paused.totals!.actions_today, 0);
    assert.ok(paused.legs.find((l: any) => l.leg === '沪深300')!.advice.every((a: any) => a.reason === '已暂停'));
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

  it('会员未开档案：profile=null、四个指数占位、totals=null', async () => {
    const { s } = svc({ ...market, profile: null });
    const r = await s.overview('u1', true, null);
    assert.strictEqual(r.member, true);
    assert.strictEqual(r.profile, null);
    assert.strictEqual(r.totals, null);
    assert.deepStrictEqual(r.legs.map((l: any) => l.leg), ['沪深300', '红利', '创业板', '科创50']);
  });

  it('会员：先卖后买、买入按现金池÷4 计量、同指数两笔递减；净值与基准分开汇总；已记账的不再出现在待执行', async () => {
    const data = {
      ...market,
      profile: { principal: 200000, start_date: '20261001', status: 'active' },
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
    assert.strictEqual(r.profile!.principal, 200000);
    assert.strictEqual(r.profile!.fee_rate, 0.0003);
    assert.strictEqual(r.profile!.min_fee, 5);
    // 现金池：200000 − 9000 = 191000（实际）/ 190000（基准）
    assert.strictEqual(r.totals!.cash, 191000);
    assert.strictEqual(r.totals!.bench_cash, 190000);
    const hl = r.legs.find((l: any) => l.leg === '红利')!;
    const hs = r.legs.find((l: any) => l.leg === '沪深300')!;
    // 先卖：红利 9000×5% = 450 → 半数进一 500 份 × 1.2 = 600 元，佣金 5（万3 不足最低）
    assert.strictEqual(hl.advice.length, 1);
    assert.strictEqual(hl.advice[0].shares, 500);
    assert.strictEqual(hl.advice[0].amount, 600);
    assert.strictEqual(hl.advice[0].fee, 5);
    assert.strictEqual(hl.advice[0].cashAfter, 191595);
    // 后买：卖后现金池 191595 ÷ 4 = 47898.75 为沪深300 当天的额度
    // 抢买 50%：预算 23949.375 含佣金 → floor(23949.375/(4×1.0003)/100)×100 = 5900 份 → 23600 元，佣金 7.08
    // 锚买 20%：额度扣掉第一笔后 24291.67 × 20% = 4858.33 → 1200 份 → 4800 元，佣金 5（与 Python day_plan 同一算术）
    assert.strictEqual(hs.advice.length, 2);
    assert.strictEqual(hs.advice[0].shares, 5900);
    assert.strictEqual(hs.advice[0].amount, 23600);
    assert.strictEqual(hs.advice[0].fee, 7.08);
    assert.strictEqual(hs.advice[0].cashAfter, 167987.92);
    assert.strictEqual(hs.advice[1].shares, 1200);
    assert.strictEqual(hs.advice[1].amount, 4800);
    assert.strictEqual(hs.advice[1].fee, 5);
    assert.strictEqual(hs.advice[1].cashAfter, 163182.92);
    assert.ok(hs.advice[0].text.includes('沪深300ETF（510300） 买入 5,900 份，约 23,600 元，佣金约 7.08 元'), hs.advice[0].text);
    // 净值：实际 191000 + 9000×1.2 = 201800；基准 190000 + 10000×1.2 = 202000
    assert.strictEqual(r.totals!.nav, 201800);
    assert.strictEqual(r.totals!.bench_nav, 202000);
    assert.strictEqual(r.totals!.pnl, 1800);
    assert.strictEqual(r.totals!.bench_pnl, 2000);
    assert.strictEqual(r.totals!.net_in, 200000);
    assert.strictEqual(r.totals!.quarter, 47750);
    assert.strictEqual(r.totals!.actions_today, 3);
    assert.strictEqual(hl.units, 9000);
    assert.strictEqual(hl.bench_units, 10000);
    assert.strictEqual(hl.value, 10800);
    assert.strictEqual(hl.share, 5.4);
    assert.strictEqual(hl.stats.edited, 1);
    // 曲线：红利 10-13 起有记账，沪深300 10-29 起有收盘；并集前向填充
    const last = r.curve[r.curve.length - 1];
    assert.strictEqual(last.date, '20261030');
    assert.strictEqual(last.nav, 201800);
    assert.strictEqual(last.bench, 202000);
    assert.ok(Math.abs(last.unit - 1.009) < 1e-9 && Math.abs(last.bench_unit - 1.01) < 1e-9);
    assert.strictEqual(r.totals!.unit_nav, last.unit);
    // 四个指数都在列表里，顺序固定
    assert.deepStrictEqual(r.legs.map((l: any) => l.leg), ['沪深300', '红利', '创业板', '科创50']);
    // 会员到期回写档案
    assert.ok(db.execs.some((e) => e.sql.includes('UPDATE user_follow_portfolio SET member_until')));
  });

  it('会员：当日卖出信号但没有该指数持仓 → 无需操作，不计入待办', async () => {
    const data = {
      ...market,
      today: [market.today[2]],
      profile: { principal: 50000, start_date: '20261001', status: 'active' },
      exec: [],
      closes: {},
    };
    const { s } = svc(data);
    const r = await s.overview('u1', true, null);
    const hl = r.legs.find((l: any) => l.leg === '红利')!;
    assert.strictEqual(hl.advice.length, 1);
    assert.ok(hl.advice[0].text.includes('你没有这个指数的持仓，本次无需操作'), hl.advice[0].text);
    assert.strictEqual(r.totals!.actions_today, 0);
    assert.strictEqual(r.totals!.nav, 50000, '无持仓时缺价也能估值');
  });

  it('档案：总资金下限 1 万、起步日不早于今天、改总资金须确认重开账本（记账与流水一起清）、暂停/恢复/移除', async () => {
    const { s, db } = svc({ ...market, profile: null, exec: [] });
    await assert.rejects(() => s.saveProfile('u1', null, { principal: 5000 }), /至少 10,000/);
    const r = await s.saveProfile('u1', null, { principal: 50000, start_date: '20200101' });
    assert.ok(r.start_date >= '20261102', '起步日不得早于今天');
    assert.ok(db.execs.some((e) => e.sql.startsWith('INSERT INTO user_follow_portfolio')));

    const withRows = svc({
      ...market,
      profile: { principal: 50000, start_date: '20261001', status: 'active' },
      exec: [{ id: 1, user_id: 'u1', leg: '沪深300' }],
    });
    await assert.rejects(
      () => withRows.s.saveProfile('u1', null, { principal: 60000, start_date: '20261001' }),
      /重新开始记账/
    );
    const ok = await withRows.s.saveProfile('u1', null, { principal: 60000, start_date: '20261001', confirm_reset: true });
    assert.strictEqual(ok.reset, true);
    assert.ok(withRows.db.execs.some((e) => e.sql.startsWith('DELETE FROM user_follow_exec WHERE user_id = ?')));
    assert.ok(withRows.db.execs.some((e) => e.sql.startsWith('DELETE FROM user_follow_cashflow WHERE user_id = ?')));
    assert.ok(ok.start_date >= '20261102');
    const p = await withRows.s.saveProfile('u1', null, { action: 'pause' });
    assert.strictEqual(p.status, 'paused');
    const rm = await withRows.s.saveProfile('u1', null, { action: 'remove' });
    assert.strictEqual(rm.reset, true);
    assert.ok(withRows.db.execs.some((e) => e.sql.startsWith('DELETE FROM user_follow_portfolio')));
    // 佣金：范围校验；只改佣金不重开账本
    await assert.rejects(
      () => withRows.s.saveProfile('u1', null, { principal: 60000, start_date: '20261001', fee_rate: 0.01 }),
      /佣金率/
    );
    const feeOnly = svc({
      ...market,
      profile: { principal: 50000, start_date: beijingDay(), status: 'active' },
      exec: [{ id: 1, user_id: 'u1', leg: '沪深300' }],
    });
    const f = await feeOnly.s.saveProfile('u1', null, { principal: 50000, start_date: beijingDay(), fee_rate: 0.0001, min_fee: 0 });
    assert.strictEqual(f.fee_rate, 0.0001);
    assert.strictEqual(f.min_fee, 0);
    assert.strictEqual(f.reset, false);
    assert.ok(!feeOnly.db.execs.some((e) => e.sql.startsWith('DELETE')), '只改佣金不删记账');
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

  it('记账修改：只改自己的；edited 重算金额（佣金按档案）；auto 回到自动值', async () => {
    const { s, db } = svc({
      ...market,
      exec: [{ id: 7, user_id: 'u1', leg: '沪深300', side: 'buy', price: 4.0, bench_shares: 2500, bench_amount: 10000 }],
      profile: null,
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
    // 档案填了佣金 ⟹ 按档案算
    const withFee = svc({ ...market, exec: [{ id: 7, user_id: 'u1', leg: '沪深300', side: 'buy' }], profile: { principal: 50000, start_date: '20261001', status: 'active', fee_rate: 0.0001, min_fee: 0 } });
    const e3 = await withFee.s.updateExec('u1', { id: 7, status: 'edited', shares: 2400, price: 4.01 });
    assert.strictEqual(e3.fee, 0.96);
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

  it('资金进出（组合级）：现金池含流水；净投入/收益额/单位净值；取出上限、日期不早于最后记账、删除不改写历史', async () => {
    const data = {
      ...market,
      today: [],
      profile: { principal: 100000, start_date: '20261001', status: 'active' },
      exec: [
        // 10-13 沪深300 买 5000 份 @4.0 = 20000 元
        { id: 1, user_id: 'u1', leg: '沪深300', signal_date: '20261010', kind: 'anchor_buy', exec_date: '20261013', etf: '510300.SH', side: 'buy', frac: 0.2, price: 4.0, bench_shares: 5000, bench_amount: 20000, shares: 5000, amount: 20000, status: 'auto', note: '' },
      ],
      flows: [
        { id: 7, user_id: 'u1', leg: '*', flow_date: '20261013', amount: 30000, note: '同日追加' },
        { id: 8, user_id: 'u1', leg: '*', flow_date: '20261020', amount: -10000, note: '取出' },
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
    // 现金池 = 100000 − 20000 + 30000 − 10000 = 100000；净投入 120000；市值 100000 + 5000×4.4 = 122000；收益 2000
    assert.strictEqual(r.totals!.cash, 100000);
    assert.strictEqual(r.totals!.net_in, 120000);
    assert.strictEqual(r.totals!.nav, 122000);
    assert.strictEqual(r.totals!.pnl, 2000);
    assert.strictEqual(r.flows.length, 2);
    // 单位净值：10-13 追加当日先按流入前市值定价（1.0）；10-20：V=122000，pre=132000 → 1.015385
    assert.ok(Math.abs(r.totals!.unit_nav - 1.015385) < 1e-5, String(r.totals!.unit_nav));
    assert.ok(r.curve.every((c: any) => typeof c.unit === 'number'));
    assert.ok(typeof r.totals!.mwr === 'number');
    // 追加：日期早于最后记账日拒绝；默认今天写入，leg 记 '*'
    await assert.rejects(() => s.cashflow('u1', { amount: 5000, flow_date: '20261010' }), /最后一笔记账日/);
    await assert.rejects(() => s.cashflow('u1', { amount: 0 }), /不能为 0/);
    const ok = await s.cashflow('u1', { amount: 5000 });
    assert.strictEqual(ok.ok, true);
    const ins = db.execs.find((e) => e.sql.startsWith('INSERT INTO user_follow_cashflow'))!;
    assert.strictEqual(ins.params[1], '*');
    assert.strictEqual(ins.params[3], 5000);
    // 取出：不超过现金池（你的 100000 / 基准 100000）
    await assert.rejects(() => s.cashflow('u1', { amount: -100001 }), /最多可取出 100,000/);
    const w = await s.cashflow('u1', { amount: -100000 });
    assert.strictEqual(w.amount, -100000);
    // 删除：其后已有记账的流水不可删（id 7 日期 10-13 = 最后记账日，允许；若早于则拒）
    const rm = await s.cashflow('u1', { action: 'remove', id: 7 });
    assert.strictEqual(rm.removed, 7);
    const later = svc({ ...data, exec: [...data.exec, { ...data.exec[0], id: 2, signal_date: '20261017', exec_date: '20261020' }] });
    await assert.rejects(() => later.s.cashflow('u1', { action: 'remove', id: 7 }), /不能删除/);
    const none = svc({ ...data, profile: null });
    await assert.rejects(() => none.s.cashflow('u1', { amount: 100 }), /尚未开启/);
  });
});
