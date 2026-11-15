import * as assert from 'assert';
import {
  addDays,
  trialLastDay,
  trialDaysLeft,
  lockBroadRow,
  FULL_TRIAL_LAUNCH,
} from '../../src/service/invest/access';

describe('invest/access.ts — 7 天完整体验与免费版字段', () => {
  it('addDays 跨月跨年', () => {
    assert.strictEqual(addDays('20261130', 1), '20261201');
    assert.strictEqual(addDays('20261228', 7), '20270104');
  });

  it('老用户从上线日起算 7 天（含当天）', () => {
    assert.strictEqual(FULL_TRIAL_LAUNCH, '20261116');
    assert.strictEqual(trialLastDay('20261023', '20261116'), '20261122');
    assert.strictEqual(trialDaysLeft('20261122', '20261116'), 7);
    assert.strictEqual(trialDaysLeft('20261122', '20261122'), 1);
    assert.strictEqual(trialDaysLeft('20261122', '20261123'), 0);
  });

  it('上线前（今天早于起算日）按完整 7 天算', () => {
    assert.strictEqual(trialDaysLeft(trialLastDay('20261101', '20261115'), '20261115'), 7);
  });

  it('新用户从第一次来访起算；从没来过＝今天起算', () => {
    assert.strictEqual(trialLastDay('20261201', '20261203'), '20261207');
    assert.strictEqual(trialLastDay(null, '20261210'), '20261216');
  });

  it('免费版宽基读数不含任何价格与买卖线', () => {
    const r = lockBroadRow({
      trade_date: '20261113', leg: '沪深300', etf: '510300', close: 4000, median: 3500,
      buy_line: 3000, sell_line: 4500, buy_mul: 0.86, sell_mul: 1.3, state: 'sell', fear: 40,
      bias60: 0.01, bias_pct: 0.5, bias_rank: 100, data_date: '20261113',
    });
    for (const k of ['close', 'median', 'buy_line', 'sell_line', 'buy_mul', 'sell_mul', 'bias60']) {
      assert.ok(!(k in r), k);
    }
    assert.strictEqual(r.state, 'sell');
    assert.strictEqual(r.locked, true);
  });
});
