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
    if (sql.includes('FROM broad_signal ORDER BY')) return d.hist || [];
    if (sql.includes('FROM trade_calendar')) return (d.cal || []).map((c: string) => ({ cal_date: c }));
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
    if (sql.includes('FROM user_follow_exec WHERE user_id')) return d.exec || [];
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
    // 抢买 50%：50000/4.0=12500 份 → 50000 元；锚买 20%：剩余 50000×0.2=10000/4.0=2500 份
    assert.strictEqual(hs.advice[0].shares, 12500);
    assert.strictEqual(hs.advice[0].amount, 50000);
    assert.strictEqual(hs.advice[1].shares, 2500);
    assert.strictEqual(hs.advice[1].amount, 10000);
    assert.ok(hs.advice[0].text.includes('沪深300ETF 买入 50,000 元'), hs.advice[0].text);
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
  });

  it('记账修改：只改自己的；edited 重算金额；auto 回到自动值', async () => {
    const { s, db } = svc({
      ...market,
      exec: [{ id: 7, user_id: 'u1', leg: '沪深300', side: 'buy', price: 4.0, bench_shares: 2500, bench_amount: 10000 }],
    });
    await assert.rejects(() => s.updateExec('u2', { id: 7, status: 'skipped' }), /不存在/);
    await assert.rejects(() => s.updateExec('u1', { id: 7, status: 'edited', shares: 2550, price: 0 }), /价格/);
    const e = await s.updateExec('u1', { id: 7, status: 'edited', shares: 2400, price: 4.01 });
    assert.strictEqual(e.amount, 9624);
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
});
