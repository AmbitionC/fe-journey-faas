import * as assert from 'assert';
import { UserHTTPService } from '../src/function/user';

/**
 * 注册频次闸行为测试（2026-08-30 复盘：8/25~8/26 两晚 39 个静默账号）。
 *
 * 直接驱动 guardSignupRate 的计数逻辑，不做源码字符串断言——这条闸门挡在
 * 全站唯一的入口漏斗层上，误杀的代价比漏放大得多，必须验真实行为。
 */

/** 最小 Redis 替身：记录 incr 计数与 expire 调用。 */
function fakeRedis(opts: { throwOnIncr?: boolean } = {}) {
  const counts: Record<string, number> = {};
  const expires: Record<string, number> = {};
  return {
    counts,
    expires,
    async incr(key: string) {
      if (opts.throwOnIncr) throw new Error('redis down');
      counts[key] = (counts[key] || 0) + 1;
      return counts[key];
    },
    async expire(key: string, ttl: number) {
      expires[key] = ttl;
      return 1;
    },
  };
}

function makeService(ip: string, redis: any): any {
  const svc: any = new UserHTTPService();
  svc.redisService = redis;
  svc.ctx = {
    ip,
    get(h: string) {
      return h === 'x-forwarded-for' ? ip : undefined;
    },
  };
  return svc;
}

/** 连续注册 n 次，返回第一次被拒的序号（全部放行则返回 null）。 */
async function firstRejectionAt(svc: any, n: number): Promise<number | null> {
  for (let i = 1; i <= n; i++) {
    try {
      await svc.guardSignupRate();
    } catch (e: any) {
      assert.ok(
        /注册过于频繁/.test(e?.message || ''),
        `拒绝文案应可读，实际：${e?.message}`
      );
      return i;
    }
  }
  return null;
}

describe('注册频次闸（按来源 IP）', () => {
  it('同 IP 每小时放行 5 次，第 6 次拒绝', async () => {
    const svc = makeService('1.2.3.4', fakeRedis());
    assert.strictEqual(await firstRejectionAt(svc, 10), 6);
  });

  it('不同 IP 互不影响——分散来源的真实用户不受牵连', async () => {
    const redis = fakeRedis();
    // 同一个 Redis 上换 IP 重来，仍应全部放行（39 个不同 IP 的注册不该被拦）
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      const svc = makeService(ip, redis);
      assert.strictEqual(await firstRejectionAt(svc, 5), null, `${ip} 被误杀`);
    }
  });

  it('Redis 不可用时放行（闸门不做注册的单点故障）', async () => {
    const svc = makeService('1.2.3.4', fakeRedis({ throwOnIncr: true }));
    assert.strictEqual(await firstRejectionAt(svc, 50), null);
  });

  it('取不到 IP 时放行，且不写任何计数键', async () => {
    const redis = fakeRedis();
    const svc: any = new UserHTTPService();
    svc.redisService = redis;
    svc.ctx = { ip: '', get: () => undefined };
    assert.strictEqual(await firstRejectionAt(svc, 3), null);
    assert.strictEqual(Object.keys(redis.counts).length, 0);
  });

  it('每个计数键只在首次自增时设 TTL（小时 3600 / 天 86400）', async () => {
    const redis = fakeRedis();
    const svc = makeService('1.2.3.4', redis);
    await svc.guardSignupRate();
    await svc.guardSignupRate();
    const ttls = Object.values(redis.expires);
    assert.deepStrictEqual(ttls.sort((a, b) => a - b), [3600, 86400]);
    // 两次调用只产生两个键（小时桶 + 天桶），不是每次都新建
    assert.strictEqual(Object.keys(redis.counts).length, 2);
  });

  it('小时桶未满但天桶超 20 时仍然拒绝', async () => {
    const redis = fakeRedis();
    const svc = makeService('9.9.9.9', redis);
    // 预置天桶到上限，小时桶留空 ⟹ 只可能是天桶把它拦下来
    const dayKey = Object.keys(redis.counts).find((k) => k.startsWith('signup:d:'));
    assert.strictEqual(dayKey, undefined);
    const today = new Date().toISOString().slice(0, 10);
    redis.counts[`signup:d:${today}:9.9.9.9`] = 20;
    await assert.rejects(() => svc.guardSignupRate(), /注册过于频繁/);
  });
});
