import * as assert from 'assert';
import {
  unitNavSeries,
  xirr,
  mergeEvents,
  sizeOrder,
  stateFromRows,
  portfolioState,
  dayPlan,
  signalOrder,
  navSeries,
  execStats,
  nextCheckDates,
  advise,
} from '../../src/service/invest/followCalc';

/** 与 invest-model tests/test_broad_follow.py 的用例一一对应：两边算术必须给同一个数。 */
describe('invest/followCalc.ts — 跟车换算（与 Python 端对照）', () => {
  it('sizeOrder：买向下取整到 100 份、卖半数进一、不超过整手持仓', () => {
    assert.deepStrictEqual(sizeOrder('buy', 0.2, 50000, 0, 3.98), { shares: 2500, amount: 9950, fee: 0 });
    assert.deepStrictEqual(sizeOrder('buy', 0.2, 1500, 0, 3.98), { shares: 0, amount: 0, fee: 0 });
    assert.deepStrictEqual(sizeOrder('sell', 0.05, 0, 2500, 4.1), { shares: 100, amount: 410, fee: 0 });
    assert.deepStrictEqual(sizeOrder('sell', 0.05, 0, 500, 4.1), { shares: 0, amount: 0, fee: 0 });
    assert.deepStrictEqual(sizeOrder('sell', 0.05, 0, 1000, 4.1), { shares: 100, amount: 410, fee: 0 });
    assert.deepStrictEqual(sizeOrder('sell', 0.5, 0, 150, 2.0), { shares: 100, amount: 200, fee: 0 });
    assert.deepStrictEqual(sizeOrder('buy', 0.2, 50000, 0, null), { shares: 0, amount: 0, fee: 0 });
  });

  it('sizeOrder：佣金（万3/最低5元）——预算含佣金、不透支；与 Python test_size_order_with_commission 同数', () => {
    assert.deepStrictEqual(sizeOrder('buy', 0.2, 50000, 0, 3.98, 0.0003, 5), { shares: 2500, amount: 9950, fee: 5 });
    assert.deepStrictEqual(sizeOrder('buy', 1.0, 398.0, 0, 3.98, 0.0003, 5), { shares: 0, amount: 0, fee: 0 });
    assert.deepStrictEqual(sizeOrder('buy', 1.0, 796.0, 0, 3.98, 0.0003, 5), { shares: 100, amount: 398, fee: 5 });
    const big = sizeOrder('buy', 0.2, 1_000_000, 0, 4.0, 0.0003, 5);
    assert.strictEqual(big.shares, 49900);
    assert.strictEqual(big.amount, 199600);
    assert.strictEqual(big.fee, Math.round(199600 * 0.0003 * 100) / 100);
    assert.ok(big.amount + big.fee <= 200000);
    assert.deepStrictEqual(sizeOrder('sell', 0.05, 0, 2500, 4.1, 0.0003, 5), { shares: 100, amount: 410, fee: 5 });
    assert.deepStrictEqual(sizeOrder('sell', 0.05, 0, 2500, 4.1, 0.0001, 0), { shares: 100, amount: 410, fee: 0.04 });
  });

  it('stateFromRows：佣金从现金扣（买＝成交额+佣金，卖＝成交额−佣金）', () => {
    const rows: any[] = [
      { side: 'buy', bench_shares: 2500, bench_amount: 9950, bench_fee: 5, shares: 2500, amount: 9950, fee: 5, status: 'auto' },
      { side: 'sell', bench_shares: 100, bench_amount: 420, bench_fee: 5, shares: 100, amount: 420, fee: 5, status: 'auto' },
    ];
    assert.deepStrictEqual(stateFromRows(50000, rows, true), { cash: 50000 - 9955 + 415, units: 2400 });
    assert.deepStrictEqual(stateFromRows(50000, rows, false), { cash: 50000 - 9955 + 415, units: 2400 });
  });

  it('stateFromRows：基准用自动值，实际跳过 skipped', () => {
    const rows: any[] = [
      { side: 'buy', bench_shares: 2500, bench_amount: 9950, shares: 2500, amount: 9950, status: 'auto' },
      { side: 'buy', bench_shares: 2000, bench_amount: 8000, shares: 0, amount: 0, status: 'skipped' },
      { side: 'sell', bench_shares: 200, bench_amount: 840, shares: 100, amount: 420, status: 'edited' },
    ];
    assert.deepStrictEqual(stateFromRows(50000, rows, true), { cash: 50000 - 9950 - 8000 + 840, units: 4300 });
    assert.deepStrictEqual(stateFromRows(50000, rows, false), { cash: 50000 - 9950 + 420, units: 2400 });
  });

  it('navSeries（组合级）：记账行按执行日生效，净值=现金池+Σ份额×收盘，缺收盘的指数前向填充', () => {
    const rows: any[] = [
      { leg: '沪深300', signal_date: '20261030', kind: 'anchor_buy', exec_date: '20261102', side: 'buy',
        bench_shares: 2500, bench_amount: 10000, shares: 2500, amount: 10000, status: 'auto' },
      { leg: '红利', signal_date: '20261030', kind: 'anchor_buy', exec_date: '20261102', side: 'buy',
        bench_shares: 1000, bench_amount: 1500, shares: 1000, amount: 1500, status: 'auto' },
    ];
    const s = navSeries(50000, rows, {
      沪深300: [{ date: '20261030', close: 3.98 }, { date: '20261102', close: 4.0 }, { date: '20261103', close: 4.4 }],
      红利: [{ date: '20261102', close: 1.5 }],
    });
    assert.deepStrictEqual(s.map((x) => [x.date, x.nav, x.bench]), [
      ['20261030', 50000, 50000],
      ['20261102', 50000, 50000],
      ['20261103', 51000, 51000],
    ]);
    assert.ok(Math.abs(s[2].unit - 1.02) < 1e-9);
  });

  const sig = (leg: string, side: string, frac: number, seq = 1) => ({
    leg, side, frac, seq, kind: 'x', etf: ({ 沪深300: '510300.SH', 创业板: '159915.SZ', 科创50: '588000.SH', 红利: '515080.SH' } as any)[leg],
  });

  it('portfolioState：一个现金池、按指数记份额；基准用自动值、实际跳过 skipped；资金流进现金池', () => {
    const rows: any[] = [
      { leg: '沪深300', exec_date: '20261013', side: 'buy', bench_shares: 2500, bench_amount: 9950, bench_fee: 5, shares: 2500, amount: 9950, fee: 5, status: 'auto' },
      { leg: '创业板', exec_date: '20261013', side: 'buy', bench_shares: 2000, bench_amount: 8000, shares: 0, amount: 0, status: 'skipped' },
      { leg: '沪深300', exec_date: '20261020', side: 'sell', bench_shares: 100, bench_amount: 420, bench_fee: 5, shares: 100, amount: 420, fee: 5, status: 'auto' },
    ];
    const b = portfolioState(50000, rows, true, [{ flow_date: '20261020', amount: 1000 }]);
    assert.strictEqual(b.cash, 50000 - 9955 - 8000 + 415 + 1000);
    assert.deepStrictEqual(b.units, { 沪深300: 2400, 创业板: 2000, 科创50: 0, 红利: 0 });
    const a = portfolioState(50000, rows, false);
    assert.strictEqual(a.cash, 50000 - 9955 + 415);
    assert.deepStrictEqual(a.units, { 沪深300: 2400, 创业板: 0, 科创50: 0, 红利: 0 });
  });

  it('dayPlan：与 Python test_day_plan_quarter_sizing_and_sell_first 同数', () => {
    const px: Record<string, number> = { 沪深300: 4.0, 创业板: 2.0, 科创50: 1.0, 红利: 1.5 };
    // 四个指数同一天都恐慌抢买 50%：各按 现金池÷4×50% ＝ 12.5%，合计正好 50%，不会缩放/透支
    const p1 = dayPlan(100000, {}, Object.keys(px).map((l) => sig(l, 'buy', 0.5)), (l) => px[l]);
    assert.deepStrictEqual(p1.items.map((i) => i.shares), [3100, 6200, 12500, 8300]);
    assert.deepStrictEqual(p1.items.map((i) => i.amount), [12400, 12400, 12500, 12450]);
    assert.strictEqual(p1.cash, 100000 - (12400 + 12400 + 12500 + 12450));
    assert.deepStrictEqual(p1.units, { 沪深300: 3100, 创业板: 6200, 科创50: 12500, 红利: 8300 });
    // 先卖后买：红利先卖 5%（回笼现金当天可用），再按卖后的现金池÷4 买沪深300
    const p2 = dayPlan(10000, { 红利: 20000 }, [sig('沪深300', 'buy', 0.2), sig('红利', 'sell', 0.05)], (l) => px[l]);
    assert.deepStrictEqual(p2.items.map((i) => i.sig.leg), ['红利', '沪深300']);
    assert.strictEqual(p2.items[0].shares, 1000);
    assert.strictEqual(p2.items[0].amount, 1500);
    assert.strictEqual(p2.items[1].shares, 100);        // (10000+1500)÷4×20% = 575 → 100 份×4
    assert.strictEqual(p2.items[1].amount, 400);
    assert.strictEqual(p2.cash, 10000 + 1500 - 400);
    assert.strictEqual(p2.units['红利'], 19000);
    // 同一指数同日两笔：第二笔按该指数那份扣掉第一笔后的余额算
    const p3 = dayPlan(400000, {}, [sig('沪深300', 'buy', 0.5, 1), sig('沪深300', 'buy', 0.2, 2)], (l) => px[l]);
    assert.strictEqual(p3.items[0].amount, 50000);
    assert.strictEqual(p3.items[1].amount, 10000);
    // 没有持仓的卖出：无需操作、不动状态；缺价：份额待算、不动状态
    const p4 = dayPlan(1000, {}, [sig('红利', 'sell', 0.05)], (l) => px[l]);
    assert.ok(p4.items[0].text.includes('你没有这个指数的持仓，本次无需操作'));
    const p5 = dayPlan(100000, {}, [sig('沪深300', 'buy', 0.2)], () => null);
    assert.ok(p5.items[0].text.includes('暂无收盘价'));
    assert.strictEqual(p5.cash, 100000);
    // 顺序：先卖后买，同方向按 沪深300 → 创业板 → 科创50 → 红利
    const order = [sig('红利', 'buy', 0.2), sig('科创50', 'sell', 0.05), sig('沪深300', 'buy', 0.2)].sort(signalOrder);
    assert.deepStrictEqual(order.map((s) => s.leg), ['科创50', '沪深300', '红利']);
  });

  it('execStats：auto 视为已执行', () => {
    assert.deepStrictEqual(execStats([{ status: 'auto' }, { status: 'skipped' }, { status: 'edited' }, {}] as any), {
      total: 4, done: 3, skipped: 1, edited: 1, rate: 75,
    });
    assert.strictEqual(execStats([]).rate, null);
  });

  it('nextCheckDates：周末/月末看下一交易日是否跨周/跨月（含节前周四）', () => {
    const days = ['20261026', '20261027', '20261028', '20261029', '20261030', '20261102', '20261104', '20261105', '20261106', '20261109'];
    assert.deepStrictEqual(nextCheckDates(days, '20261027'), { weekEnd: '20261030', monthEnd: '20261030' });
    assert.deepStrictEqual(nextCheckDates(days, '20261102'), { weekEnd: '20261106', monthEnd: null });
    // 11-03 休市不在列表里：11-02 之后下一交易日 11-04 同周，不算周末
    assert.strictEqual(nextCheckDates(days, '20261102').weekEnd, '20261106');
    // 判定日本身是周五+月末（10-30）：它的检查已做过，「下次」是 11-06；本月内没有下一个月末 → null
    assert.deepStrictEqual(nextCheckDates(days, '20261030'), { weekEnd: '20261106', monthEnd: null });
    const holiday = ['20261028', '20261029', '20261102'];
    assert.deepStrictEqual(nextCheckDates(holiday, '20261028'), { weekEnd: '20261029', monthEnd: '20261029' });
  });

  it('advise：文案与前后状态', () => {
    const a = advise({ side: 'buy', frac: 0.2, kind: 'anchor_buy', etf: '510300.SH' }, 50000, 0, 3.98);
    assert.strictEqual(a.text, '沪深300ETF（510300） 买入 2,500 份，约 9,950 元');
    assert.strictEqual(a.cashAfter, 40050);
    assert.strictEqual(a.unitsAfter, 2500);
    // 带佣金：文案附佣金、现金多扣 5 元（与 Python follow_user_lines 同数：40,045）
    const af = advise({ side: 'buy', frac: 0.2, kind: 'anchor_buy', etf: '510300.SH' }, 50000, 0, 3.98, 0.0003, 5);
    assert.strictEqual(af.text, '沪深300ETF（510300） 买入 2,500 份，约 9,950 元，佣金约 5.00 元');
    assert.strictEqual(af.cashAfter, 40045);
    assert.strictEqual(af.fee, 5);
    const b = advise({ side: 'sell', frac: 0.05, kind: 'sell', etf: '515080.SH' }, 100, 500, 1.4);
    assert.strictEqual(b.skipped, true);
    assert.ok(b.text.includes('持仓不足一手的比例'));
    const c = advise({ side: 'buy', frac: 0.2, kind: 'anchor_buy', etf: '510300.SH' }, 50000, 0, null);
    assert.ok(c.text.includes('暂无收盘价'));
  });

  it('资金流：同日先执行后资金流；份额法单位净值不因出入金跳变；XIRR', () => {
    const rows = [
      { leg: '沪深300', signal_date: '20261010', kind: 'anchor_buy', exec_date: '20261013', side: 'buy', frac: 0.2, bench_shares: 5000, bench_amount: 20000, shares: 5000, amount: 20000, status: 'auto' },
    ];
    const flows = [{ flow_date: '20261013', amount: 30000 }, { flow_date: '20261020', amount: -10000 }];
    assert.deepStrictEqual(mergeEvents(rows as any, flows).map((e) => e.kind), ['exec', 'flow', 'flow']);
    assert.deepStrictEqual(stateFromRows(100000, rows as any, false, flows), { cash: 100000, units: 5000 });
    assert.deepStrictEqual(stateFromRows(100000, rows as any, false), { cash: 80000, units: 5000 });
    // 与 Python test_unit_nav_does_not_jump_on_cashflow 同数
    const u = unitNavSeries(100, [
      { date: 'd1', value: 100 }, { date: 'd2', value: 110 }, { date: 'd3', value: 160 }, { date: 'd4', value: 176 },
    ], [{ flow_date: 'd3', amount: 50 }]);
    assert.deepStrictEqual(u.map((x) => Math.round(x * 1e4) / 1e4), [1, 1.1, 1.1, 1.21]);
    const u2 = unitNavSeries(100, [{ date: 'd1', value: 100 }, { date: 'd2', value: 110 }, { date: 'd3', value: 70 }], [{ flow_date: 'd3', amount: -40 }]);
    assert.strictEqual(Math.round(u2[2] * 1e4) / 1e4, 1.1);
    // XIRR：−100 → 一年后 110 ≈ 10%；追加后同样收敛
    const r1 = xirr([{ date: '20200101', amount: -100 }, { date: '20210101', amount: 110 }]);
    assert.ok(r1 != null && Math.abs(r1 - 0.1) < 1e-3, String(r1));
    const r2 = xirr([{ date: '20200101', amount: -100 }, { date: '20200701', amount: -100 }, { date: '20210101', amount: 220 }]);
    assert.ok(r2 != null && r2 > 0.1 && r2 < 0.2, String(r2));
    assert.strictEqual(xirr([{ date: '20200101', amount: -100 }]), null);
  });
});
