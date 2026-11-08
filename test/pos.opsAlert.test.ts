import * as assert from 'assert';
import { normalizeOpsAlert, opsAlertCounterKey } from '../src/service/pos/opsAlert';

describe('pos opsAlert', () => {
  it('accepts a short subject and text', () => {
    assert.deepStrictEqual(normalizeOpsAlert({ subject: ' 验证码\n待处理 ', text: '请在 Edge 完成验证' }), { subject: '验证码 待处理', text: '请在 Edge 完成验证' });
  });
  it('rejects missing or oversized fields', () => {
    assert.strictEqual(normalizeOpsAlert({ subject: '', text: 'x' }), undefined);
    assert.strictEqual(normalizeOpsAlert({ subject: 'x'.repeat(121), text: 'x' }), undefined);
    assert.strictEqual(normalizeOpsAlert({ subject: 'x', text: 'x'.repeat(4001) }), undefined);
    assert.strictEqual(normalizeOpsAlert(null), undefined);
  });
  it('counts per Beijing day', () => {
    assert.strictEqual(opsAlertCounterKey(new Date('2026-11-08T16:30:00Z')), 'pos:opsAlert:2026-11-09');
  });
});
