import * as assert from 'assert';
import { resolveHealthToken } from '../src/service/health/auth';

describe('health/auth 记餐专用令牌边界', () => {
  const cfg = { apiToken: 'main-token-xxxxxxxx', agentToken: 'agent-token-yyyyyyyy' };

  it('主令牌 = full；记餐令牌 = meal；其余拒绝', () => {
    assert.strictEqual(resolveHealthToken({ 'x-health-token': cfg.apiToken }, cfg), 'full');
    assert.strictEqual(resolveHealthToken({ 'x-health-token': cfg.agentToken }, cfg), 'meal');
    assert.strictEqual(resolveHealthToken({ authorization: `Bearer ${cfg.agentToken}` }, cfg), 'meal');
    assert.strictEqual(resolveHealthToken({ 'x-health-token': 'nope' }, cfg), null);
    assert.strictEqual(resolveHealthToken({}, cfg), null);
  });

  it('未配置记餐令牌时，空串/任意值都不能冒充', () => {
    const c = { apiToken: cfg.apiToken, agentToken: '' };
    assert.strictEqual(resolveHealthToken({ 'x-health-token': '' }, c), null);
    assert.strictEqual(resolveHealthToken({ 'x-health-token': 'anything' }, c), null);
  });

  it('记餐令牌过短或与主令牌相同则不生效（防误配成弱口令/越权）', () => {
    assert.strictEqual(resolveHealthToken({ 'x-health-token': 'short' }, { apiToken: 'm'.repeat(20), agentToken: 'short' }), null);
    const same = { apiToken: 'same-token-zzzzzzzz', agentToken: 'same-token-zzzzzzzz' };
    assert.strictEqual(resolveHealthToken({ 'x-health-token': same.apiToken }, same), 'full');
  });
});
