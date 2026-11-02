import * as assert from 'assert';
import {
  sizeOrder,
  stateFromRows,
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

  it('navSeries：记账行按执行日生效，净值=现金+份额×收盘', () => {
    const rows: any[] = [
      { leg: 'x', signal_date: '20261030', kind: 'anchor_buy', exec_date: '20261102', side: 'buy',
        bench_shares: 2500, bench_amount: 10000, shares: 2500, amount: 10000, status: 'auto' },
    ];
    const s = navSeries(50000, rows, [
      { date: '20261030', close: 3.98 },
      { date: '20261102', close: 4.0 },
      { date: '20261103', close: 4.4 },
    ]);
    assert.deepStrictEqual(s.map((x) => [x.date, x.nav, x.bench]), [
      ['20261030', 50000, 50000],
      ['20261102', 50000, 50000],
      ['20261103', 51000, 51000],
    ]);
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
});
