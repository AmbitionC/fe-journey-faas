import * as assert from 'assert';
import {
  applyEffects,
  classifyNoteByRule,
  computeGaps,
  freshness,
  guardEventStatus,
  movingAvg,
  normDate,
  summarizeWealth,
  BalanceLine,
} from '../src/service/pos/logic';

const line = (p: Partial<BalanceLine>): BalanceLine => ({
  key: 'x',
  name: 'x',
  kind: 'cash',
  side: 'asset',
  currency: 'CNY',
  amount: 0,
  asOf: '2026-10-01',
  factType: 'measured',
  source: 't',
  liquid: false,
  investable: false,
  includeNetWorth: true,
  ...p,
});

describe('pos/logic 纯函数口径', () => {
  describe('summarizeWealth 净资产', () => {
    it('资产 − 负债；自住房 include_networth=0 不计入', () => {
      const s = summarizeWealth(
        [
          line({ name: 'A股', amount: 475000, investable: true }),
          line({ name: '房子', kind: 'property', amount: 3000000, includeNetWorth: false }),
          line({ name: '房贷', side: 'liability', kind: 'mortgage', amount: 500000 }),
        ],
        {}
      );
      assert.strictEqual(s.totalAssets, 475000);
      assert.strictEqual(s.totalLiabilities, 500000);
      assert.strictEqual(s.netWorth, -25000);
      assert.strictEqual(s.investable, 475000);
      assert.strictEqual(s.hasLiabilityRecord, true);
    });

    it('外币缺汇率：不折算、标 partial，绝不用默认汇率', () => {
      const s = summarizeWealth([line({ name: '美股', currency: 'USD', amount: 23000 })], { USD: null });
      assert.strictEqual(s.partial, true);
      assert.strictEqual(s.lines[0].amountCny, null);
      assert.strictEqual(s.lines[0].fxMissing, true);
      assert.strictEqual(s.netWorth, null);
    });

    it('外币按给定汇率折算', () => {
      const s = summarizeWealth([line({ currency: 'USD', amount: 100 })], {
        USD: { rate: 7.1, asOf: '2026-10-01', source: 't' },
      });
      assert.strictEqual(s.netWorth, 710);
    });

    it('区间余额（两三万）取中位数并标 approximate', () => {
      const s = summarizeWealth(
        [line({ amount: null, low: 20000, high: 30000, factType: 'reported', liquid: true })],
        {}
      );
      assert.strictEqual(s.netWorth, 25000);
      assert.strictEqual(s.liquidCash, 25000);
      assert.strictEqual(s.approximate, true);
    });

    it('提前还贷不造成净资产损失：现金 −15 万、房贷 −15 万，净资产不变', () => {
      const before = summarizeWealth(
        [line({ amount: 300000 }), line({ side: 'liability', amount: 800000 })],
        {}
      );
      const after = summarizeWealth(
        [line({ amount: 150000 }), line({ side: 'liability', amount: 650000 })],
        {}
      );
      assert.strictEqual(before.netWorth, after.netWorth);
    });
  });

  describe('applyEffects 事件结转', () => {
    it('同一账户多次叠加；负债按欠款为正', () => {
      const r = applyEffects({ 1: 300000, 2: 800000 }, [
        { accountId: 1, delta: -100000 },
        { accountId: 1, delta: -50000 },
        { accountId: 2, delta: -150000 },
      ]);
      assert.deepStrictEqual(
        r.sort((a, b) => a.accountId - b.accountId),
        [
          { accountId: 1, prev: 300000, next: 150000 },
          { accountId: 2, prev: 800000, next: 650000 },
        ]
      );
    });

    it('结转日前无余额的账户直接报错，不臆造起点', () => {
      assert.throws(() => applyEffects({ 3: null }, [{ accountId: 3, delta: -1 }]), /没有余额记录/);
    });
  });

  describe('随手记分类与计划护栏', () => {
    it('「打算…提前还房贷」= plan，事件候选强制 planned', () => {
      const t = '我打算十几号提前还房贷 15 万，资金还要安排一下';
      assert.strictEqual(classifyNoteByRule(t).kind, 'plan');
      assert.strictEqual(classifyNoteByRule(t).domain, 'wealth');
      assert.strictEqual(guardEventStatus(t, 'done'), 'planned');
    });

    it('「已经还了」允许 done', () => {
      assert.strictEqual(guardEventStatus('今天已经还了房贷 15 万', 'done'), 'done');
    });

    it('决定 / 担忧 / 家庭域', () => {
      assert.strictEqual(classifyNoteByRule('决定副业先不做会员').kind, 'decision');
      assert.strictEqual(classifyNoteByRule('有点担心最近睡眠').kind, 'worry');
      assert.strictEqual(classifyNoteByRule('周末陪孩子去公园').domain, 'family');
    });
  });

  describe('新鲜度与缺口', () => {
    it('超过阈值为 stale，缺失为 missing', () => {
      assert.strictEqual(freshness('body_weight', '2026-10-01', '2026-10-09').status, 'stale');
      assert.strictEqual(freshness('body_weight', '2026-10-05', '2026-10-09').status, 'fresh');
      assert.strictEqual(freshness('income', null, '2026-10-09').status, 'missing');
    });

    it('到期未确认的计划事件排最前；没体脂基线会提示', () => {
      const gaps = computeGaps({
        today: '2026-10-20',
        hasCashAccount: true,
        hasLiability: true,
        salaryLatest: { period: '2026-09', basis: 'unknown' },
        overduePlanned: [{ id: 1, title: '提前还贷', plannedDate: '2026-10-15' }],
        investA: '2026-10-19',
        fxMissing: false,
        bodyFatAsOf: null,
        weightAsOf: '2026-10-19',
        waistAsOf: '2026-10-18',
        goalsCount: 1,
        factsCount: 1,
      });
      assert.strictEqual(gaps[0].key, 'overdue:1');
      assert.ok(gaps.some(g => g.key === 'salary_basis'));
      assert.ok(gaps.some(g => g.key === 'body_fat' && g.text.includes('基线')));
      assert.ok(!gaps.some(g => g.key === 'weight'));
    });
  });

  it('normDate 兼容 invest 库 YYYYMMDD', () => {
    assert.strictEqual(normDate('20261009'), '2026-10-09');
    assert.strictEqual(normDate('2026-10-09 08:00:00'), '2026-10-09');
    assert.strictEqual(normDate(null), null);
  });

  it('movingAvg 7 日均线按日历日窗口', () => {
    const r = movingAvg([
      { date: '2026-10-01', value: 90 },
      { date: '2026-10-05', value: 88 },
      { date: '2026-10-09', value: 86 },
    ]);
    assert.deepStrictEqual(
      r.map(x => x.value),
      [90, 89, 87]
    );
  });
});
