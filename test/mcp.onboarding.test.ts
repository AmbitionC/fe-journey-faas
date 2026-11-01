import * as assert from 'assert';
import {
  lowBalanceNotice,
  missingKeyReason,
  onboardingFor,
} from '../src/mcp/onboarding';

describe('MCP 新用户引导', () => {
  it('分辨没带 Key / 环境变量没展开 / 格式不对', () => {
    assert.strictEqual(missingKeyReason({}), 'missing');
    assert.strictEqual(missingKeyReason({ authorization: 'Bearer ' }), 'env_unset');
    assert.strictEqual(missingKeyReason({ authorization: 'Bearer ${X_KEY}' }), 'env_unset');
    assert.strictEqual(missingKeyReason({ authorization: 'Bearer $X_KEY' }), 'env_unset');
    assert.strictEqual(missingKeyReason({ authorization: 'Bearer undefined' }), 'env_unset');
    assert.strictEqual(missingKeyReason({ 'x-api-key': 'abc' }), 'bad_format');
  });

  it('低余额只在跌破阈值那一次提醒', () => {
    assert.ok(lowBalanceNotice(9, 2));
    assert.strictEqual(lowBalanceNotice(7, 2), null); // 之前已经 <10
    assert.strictEqual(lowBalanceNotice(10, 2), null); // 还没跌破
    assert.strictEqual(lowBalanceNotice(9, 0), null);
    assert.ok(/还剩 0 点/.test(lowBalanceNotice(0, 10)!));
  });

  it('体验用户才有 onboarding，带示例问法与另一个产品', () => {
    assert.strictEqual(onboardingFor('agent', 'member', 300), null);
    const o = onboardingFor('invest', 'free', 50)!;
    assert.ok(o.balance.includes('50 点'));
    assert.strictEqual(o.tryAsking.length, 3);
    assert.ok(o.alsoAvailable.includes('Agent Journey'));
    assert.ok(onboardingFor('agent', 'free', 0)!.balance.includes('from=credit_exhausted'));
  });
});
