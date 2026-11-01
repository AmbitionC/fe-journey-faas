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

describe('MCP 站点表（两个产品各自独立）', () => {
  const { payReturnUrl, rechargeLink, siteOf } = require('../src/mcp/sites');

  it('付款回跳只认白名单路径，不认的回该站默认页（防开放跳转）', () => {
    assert.strictEqual(
      payReturnUrl('agent', '/membership'),
      'https://www.agent-journey.cn/membership'
    );
    assert.strictEqual(
      payReturnUrl('agent', '/membership?x=1#pricing'),
      'https://www.agent-journey.cn/membership'
    );
    assert.strictEqual(payReturnUrl('agent', '/evil'), 'https://www.agent-journey.cn/developer');
    assert.strictEqual(
      payReturnUrl('agent', 'https://evil.example/membership'),
      'https://www.agent-journey.cn/developer'
    );
    assert.strictEqual(payReturnUrl('agent'), 'https://www.agent-journey.cn/developer');
    // Invest 站没有会员页，带了也回 /skills
    assert.strictEqual(
      payReturnUrl('invest', '/membership'),
      'https://invest-journey.vercel.app/skills'
    );
    assert.strictEqual(payReturnUrl('invest'), 'https://invest-journey.vercel.app/skills');
    // 未知产品按 Agent Journey
    assert.strictEqual(payReturnUrl(undefined, '/membership'), 'https://www.agent-journey.cn/membership');
  });

  it('充值链接按产品带来源参数', () => {
    assert.strictEqual(
      rechargeLink('credit_low', 'invest'),
      'https://invest-journey.vercel.app/skills?from=credit_low#pricing'
    );
    assert.strictEqual(
      rechargeLink('credit_exhausted', 'agent'),
      'https://www.agent-journey.cn/developer?from=credit_exhausted#pricing'
    );
    assert.strictEqual(siteOf('nope').name, 'Agent Journey');
  });
});
