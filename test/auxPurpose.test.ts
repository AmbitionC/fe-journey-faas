import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AiProxyService } from '../src/service/ai/proxy';

/**
 * 辅助调用（猜你想问）与用户提问的分离（2026-09-20）。
 *
 * 背景：前端自 2026-07 就在发 purpose:'suggest'，服务端一直没读，于是
 * ① 自动调用与用户提问在 ai_usage_log 里无法区分（近 30 天 232 次调用 / iris_ask 仅 4 次），
 * ② 自动调用吃掉用户自己的每日提问额度。
 */

/** 最小 Redis 替身：只记 incr 次数与 expire。 */
function fakeRedis() {
  const counts: Record<string, number> = {};
  return {
    counts,
    async incr(key: string) {
      counts[key] = (counts[key] || 0) + 1;
      return counts[key];
    },
    async expire() {
      return 1;
    },
  };
}

function makeProxy(redis: any, limit = 3): any {
  const svc: any = new AiProxyService();
  svc.redisService = redis;
  svc.membershipConfig = {}; // 非限免期
  svc.aiConfig = { rateLimit: { freeUserPerDay: limit, freeWindowSeconds: 86400 } };
  return svc;
}

describe('辅助调用配额桶', () => {
  it('辅助调用与用户提问记在不同的 key 上（不互相消耗）', async () => {
    const redis = fakeRedis();
    const svc = makeProxy(redis);
    await svc.checkRateLimit('guest:1.2.3.4', false); // 用户提问
    await svc.checkRateLimit('guest:1.2.3.4', false, 'aux'); // 界面自动
    const keys = Object.keys(redis.counts).sort();
    assert.strictEqual(keys.length, 2, `应有两个独立桶，实际：${keys}`);
    assert.ok(keys.some((k) => k.includes(':aux:')), '缺少 aux 桶');
    assert.ok(keys.every((k) => redis.counts[k] === 1), '两个桶各计一次');
  });

  it('辅助调用打满后，用户仍能提问（额度没被自动调用吃掉）', async () => {
    const redis = fakeRedis();
    const svc = makeProxy(redis, 3);
    for (let i = 0; i < 3; i++) await svc.checkRateLimit('guest:9.9.9.9', false, 'aux');
    await assert.rejects(
      () => svc.checkRateLimit('guest:9.9.9.9', false, 'aux'),
      /次数已用完/,
      'aux 桶自身应有上限'
    );
    // 关键断言：用户的提问桶仍是空的
    await svc.checkRateLimit('guest:9.9.9.9', false);
    assert.strictEqual(redis.counts['ai:rate:day:guest:9.9.9.9'], 1);
  });

  it('会员与限免期一律放行，aux 也不计数', async () => {
    const redis = fakeRedis();
    const member = makeProxy(redis);
    await member.checkRateLimit('13800138000', true, 'aux');
    const free = makeProxy(fakeRedis());
    free.membershipConfig = { freeForAll: true };
    await free.checkRateLimit('guest:1.1.1.1', false, 'aux');
    assert.strictEqual(Object.keys(redis.counts).length, 0, '会员不应写计数键');
  });

  it('游客超限文案指向注册而非付费', async () => {
    const svc = makeProxy(fakeRedis(), 1);
    await svc.checkRateLimit('guest:5.5.5.5', false);
    await assert.rejects(() => svc.checkRateLimit('guest:5.5.5.5', false), /注册即可享 14 天不限次/);
    const svc2 = makeProxy(fakeRedis(), 1);
    await svc2.checkRateLimit('13800138000', false);
    await assert.rejects(() => svc2.checkRateLimit('13800138000', false), /开通会员/);
  });
});

describe('辅助调用的计量标签', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'function', 'ai.ts'), 'utf8');

  it('服务端确实读取了 purpose（前端发了两个月一直没人读）', () => {
    assert.ok(/AUX_PURPOSES\.has\(String\(body\.purpose/.test(src), '未读取 body.purpose');
  });

  it('辅助调用改写 module 为 aux:<purpose>，使 byModule 可分离成本', () => {
    assert.ok(/module: `aux:\$\{body\.purpose\}`/.test(src), 'module 未改写为 aux:<purpose>');
  });
});
