import * as assert from 'assert';
import { spendingSummary } from '../src/service/pos/snapshot';

describe('pos/snapshot 消费摘要', () => {
  it('只算 consume；dup/void 不出现；其余按 kind 单列；按月、分类、商户汇总', () => {
    const s = spendingSummary([
      { txn_time: '2026-09-02 12:00:00', kind: 'consume', category: '餐饮', counterparty: '美团', net: 30 },
      { txn_time: '2026-09-15 12:00:00', kind: 'consume', category: '餐饮', counterparty: '美团', net: 20 },
      { txn_time: '2026-10-01 12:00:00', kind: 'consume', category: '汽车', counterparty: '停车', net: 50 },
      { txn_time: '2026-10-02 12:00:00', kind: 'consume', category: '餐饮', counterparty: '美团', net: -5 },
      { txn_time: '2026-10-02 12:00:00', kind: 'dup', category: '已在支付宝/微信', counterparty: 'x', net: 999 },
      { txn_time: '2026-10-03 12:00:00', kind: 'family', category: '转给家人', counterparty: '慧慧', net: 1000 },
      { txn_time: '2026-10-03 12:00:00', kind: 'void', category: '无效', counterparty: 'y', net: 7 },
    ]);
    assert.strictEqual(s.consumeTotal, 95);
    assert.deepStrictEqual(s.months, [
      { month: '2026-09', total: 50, count: 2 },
      { month: '2026-10', total: 45, count: 2 },
    ]);
    assert.strictEqual(s.monthlyAvg, 48);
    assert.deepStrictEqual(s.byCategory[0], { category: '汽车', total: 50, count: 1, share: 52.6 });
    assert.deepStrictEqual(s.topMerchants[0], { merchant: '停车', total: 50, count: 1 });
    assert.deepStrictEqual(s.nonConsume, [{ kind: 'family', category: '转给家人', total: 1000, count: 1 }]);
    assert.deepStrictEqual(s.window, { from: '2026-09-02', to: '2026-10-03' });
  });
});
