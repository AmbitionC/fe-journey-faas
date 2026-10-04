import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AiProxyService } from '../src/service/ai/proxy';
import { isAuxPurpose, auxModuleFor, auxBucketFor } from '../src/common/aiPurpose';

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

  it('超限文案不再许诺试用、也不引导开通会员（2026-10-02 起两者均已停止）', async () => {
    const svc = makeProxy(fakeRedis(), 1);
    await svc.checkRateLimit('guest:5.5.5.5', false);
    await assert.rejects(() => svc.checkRateLimit('guest:5.5.5.5', false), (e: any) => {
      const m = String(e?.message || '');
      assert.ok(/RATE_LIMIT/.test(m), '前端靠 RATE_LIMIT 识别额度用尽，前缀不能丢');
      assert.ok(/登录后可保存学习记录/.test(m), `游客文案应与前端一致：${m}`);
      assert.ok(!/14 *天|开通会员/.test(m), `不得再许诺已停止的权益：${m}`);
      return true;
    });
    const svc2 = makeProxy(fakeRedis(), 1);
    await svc2.checkRateLimit('13800138000', false);
    await assert.rejects(() => svc2.checkRateLimit('13800138000', false), (e: any) => {
      const m = String(e?.message || '');
      assert.ok(/明天再来/.test(m), `登录用户文案应与前端一致：${m}`);
      assert.ok(!/14 *天|开通会员/.test(m), `不得再引导已暂停的会员售卖：${m}`);
      return true;
    });
  });
});

describe('辅助调用判定（共享模块）', () => {
  it('只认白名单内的用途', () => {
    assert.strictEqual(isAuxPurpose('suggest'), true);
    for (const bad of ['', 'chat', 'SUGGEST', ' suggest', undefined, null, 0, {}]) {
      assert.strictEqual(isAuxPurpose(bad as any), false, `${JSON.stringify(bad)} 不该算辅助调用`);
    }
  });

  it('module 与桶名成对出现', () => {
    assert.strictEqual(auxModuleFor('suggest'), 'aux:suggest');
    assert.strictEqual(auxBucketFor('suggest'), 'aux');
    assert.strictEqual(auxModuleFor('chat'), undefined);
    assert.strictEqual(auxBucketFor('chat'), undefined);
  });
});

/**
 * ⚠️ 这一组是本次事故的直接回归测试。
 *
 * `/api/ai/chat/stream` 有**两个**实现：src/function/ai.ts 的 Midway 处理器，
 * 以及 server.js 里绕过框架直写 SSE 的 handleStream。**线上真正服务这条路由的是
 * server.js**。2026-09-20 我只改了前者——六条测试全绿、CI 全绿、部署全绿，
 * 线上却毫无变化；9/27 用一次带唯一标记的探针请求才发现（落的是 probe-0927 而非
 * aux:suggest）。所以这里必须直接盯 server.js。
 */
describe('线上实际处理器（server.js）也必须认 purpose', () => {
  const server = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

  it('从共享模块引入判定，而不是自己再写一份', () => {
    assert.ok(
      /require\('\.\/dist\/common\/aiPurpose'\)/.test(server),
      'server.js 未引用共享判定模块（两份实现必然漂移）'
    );
  });

  it('限流传入 aux 桶', () => {
    assert.ok(
      /checkRateLimit\(userId, isMember, auxBucketFor\(body\.purpose\)\)/.test(server),
      'server.js 的 checkRateLimit 未传 aux 桶'
    );
  });

  it('辅助调用改写 context.module 为 aux:<purpose>', () => {
    assert.ok(/auxModuleFor\(body\.purpose\)/.test(server), '未取 auxModuleFor');
    assert.ok(/context\.module = auxModule/.test(server), '未改写 context.module');
  });

  it('改写发生在 forwardStream 之前（否则计量拿到的还是旧 module）', () => {
    const iAssign = server.indexOf('context.module = auxModule');
    const iStream = server.indexOf('aiProxyService.forwardStream(messages, context');
    assert.ok(iAssign > 0 && iStream > 0, '未找到关键调用');
    assert.ok(iAssign < iStream, 'module 改写必须早于 forwardStream');
  });
});
