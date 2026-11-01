import * as assert from 'assert';
import {
  authHelp,
  lowBalanceNotice,
  missingKeyReason,
  onboardingFor,
  scopeHelp,
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

  it('体验用户才有 onboarding，带示例问法；只讲本产品，不推另一个', () => {
    assert.strictEqual(onboardingFor('agent', 'member', 300), null);
    const o = onboardingFor('invest', 'free', 50)!;
    assert.ok(o.balance.includes('50 点'));
    assert.strictEqual(o.tryAsking.length, 3);
    assert.strictEqual(o.alsoAvailable, undefined);
    assert.ok(!JSON.stringify(o).includes('Agent Journey'));
    assert.ok(!JSON.stringify(onboardingFor('agent', 'free', 50)).includes('Invest'));
    assert.ok(onboardingFor('agent', 'free', 0)!.balance.includes('https://www.agent-journey.cn/developer?from=credit_exhausted'));
    assert.ok(onboardingFor('invest', 'free', 0)!.balance.includes('https://invest-journey.vercel.app/skills?from=credit_exhausted'));
  });

  it('Key 报错排查与低余额提醒按产品给自己站的链接', () => {
    assert.ok(authHelp('missing', 'invest').includes('https://invest-journey.vercel.app/skills'));
    assert.ok(!authHelp('missing', 'invest').includes('agent-journey'));
    assert.ok(authHelp('revoked', 'agent').includes('https://www.agent-journey.cn/developer'));
    assert.ok(scopeHelp('invest').includes('Invest Journey') && !scopeHelp('invest').includes('Agent'));
    assert.ok(lowBalanceNotice(9, 2, 'invest')!.includes('invest-journey.vercel.app/skills?from=credit_low'));
    assert.ok(lowBalanceNotice(9, 2)!.includes('agent-journey.cn/developer?from=credit_low'));
  });
});
