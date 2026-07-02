import * as assert from 'assert';
import {
  modelTrust,
  confLabel,
  modelView,
  movingAverage,
  deriveSnapshotRow,
} from '../../src/service/invest/calc';

describe('invest/calc.ts — 模型研判/均线/快照衍生（与 Python 端对照）', () => {
  describe('modelTrust()', () => {
    it('IC_IR 映射 0..1，0.6 满信任', () => {
      assert.strictEqual(modelTrust(0.6), 1);
      assert.strictEqual(modelTrust(0.3), 0.5);
      assert.strictEqual(modelTrust(-0.1), 0);
      assert.strictEqual(modelTrust(null), 0);
      assert.strictEqual(modelTrust(1.2), 1);
    });
  });

  describe('confLabel()', () => {
    it('分档标签与 Python _conf_label 一致', () => {
      assert.strictEqual(confLabel(0, null), '无（模型未就绪）');
      assert.strictEqual(confLabel(0, -0.2), '失效（IC≤0，勿依赖）');
      assert.strictEqual(confLabel(0.7, 0.42), '高');
      assert.strictEqual(confLabel(0.5, 0.3), '中');
      assert.strictEqual(confLabel(0.2, 0.12), '低');
    });
  });

  describe('modelView()', () => {
    it('复刻 Python _model_view："看好 前8% ★★★"', () => {
      // rank 0.92 → top 8%，conviction 0.84；trust 1 → c=0.84 → ★★★
      assert.strictEqual(modelView(0.92, 1), '看好 前8% ★★★');
      // 无覆盖 → —
      assert.strictEqual(modelView(null, 1), '—');
      // 中性区：rank 0.5 → 前50%，conviction 0 → ★
      assert.strictEqual(modelView(0.5, 1), '中性 前50% ★');
      // 低信任衰减星级：rank 0.9(conviction .8) × trust .4 = .32 → ★★
      assert.strictEqual(modelView(0.9, 0.4), '看好 前10% ★★');
      // 看淡：rank 0.1 → 前90%
      assert.strictEqual(modelView(0.1, 1), '看淡 前90% ★★★');
    });
  });

  describe('movingAverage()', () => {
    it('窗口对齐：前 window-1 为 null', () => {
      const ma = movingAverage([1, 2, 3, 4, 5], 3);
      assert.deepStrictEqual(ma, [null, null, 2, 3, 4]);
    });
    it('window 大于长度时全 null', () => {
      assert.deepStrictEqual(movingAverage([1, 2], 5), [null, null]);
    });
  });

  describe('deriveSnapshotRow()', () => {
    it('等价 ingest_holding_snapshot 的补算公式', () => {
      const r = deriveSnapshotRow({
        code: '000833.SZ',
        asset_type: 'stock',
        shares: 2500,
        cost_price: 23.322,
        last_price: 24.71,
      });
      assert.strictEqual(r.market_value, 61775);
      assert.strictEqual(r.pnl, 3470);
      // (24.710/23.322-1)*100 = 5.9518... round4
      assert.strictEqual(r.pnl_pct, 5.9515);
      assert.strictEqual(r.available, 2500);
    });
    it('成本为 0 时 pnl_pct=0，不除零', () => {
      const r = deriveSnapshotRow({
        code: 'X', asset_type: 'stock', shares: 100, cost_price: 0, last_price: 10,
      });
      assert.strictEqual(r.pnl_pct, 0);
      assert.strictEqual(r.market_value, 1000);
    });
  });
});
