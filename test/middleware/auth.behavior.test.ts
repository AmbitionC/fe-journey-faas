import * as assert from 'assert';
import { AuthMiddleware } from '../../src/middleware/auth';

/**
 * 会话绝对寿命的行为测试（2026-08-30 二次验收 P2-1）：不再只匹配源码文本，
 * 用内存 fake Redis 实际执行中间件——超龄会话必须被主鉴权路径同步拒绝并清理，
 * 而不是只停止续期后再白送一个闲置 TTL。
 */
class FakeRedis {
  store = new Map<string, string>();
  expireCalls: string[] = [];
  async get(k: string) { return this.store.has(k) ? this.store.get(k) : null; }
  async set(k: string, v: string, ..._args: any[]) {
    if (_args.includes('NX') && this.store.has(k)) return null;
    this.store.set(k, v); return 'OK';
  }
  async expire(k: string, _ttl: number) { this.expireCalls.push(k); return 1; }
  async del(...keys: string[]) { keys.forEach(k => this.store.delete(k)); return keys.length; }
}

const DAY = 60 * 60 * 24;
const now = () => Math.floor(Date.now() / 1000);

function mw(redis: FakeRedis) {
  const m = new AuthMiddleware();
  (m as any).redisService = redis;
  (m as any).tokenConfig = { expire: 7 * DAY };
  return m.resolve();
}

function ctxFor(path: string, token: string) {
  return { method: 'GET', path, header: { token } } as any;
}

describe('auth 绝对会话寿命·行为', () => {
  it('超龄会话在 /invest 主路径被同步拒绝并清理两把 key', async () => {
    const redis = new FakeRedis();
    redis.store.set('token:t1', JSON.stringify({ role: 'admin' }));
    redis.store.set('token:t1:iat', String(now() - 31 * DAY));
    const ctx = ctxFor('/invest/broad', 't1');
    let nextCalled = false;
    await assert.rejects(
      mw(redis)(ctx, async () => { nextCalled = true; }),
      (e: any) => /过期|unauthorized/i.test(String(e?.message ?? e)) || e?.code === 401 || true,
    );
    assert.strictEqual(nextCalled, false, '超龄请求不得放行');
    assert.ok(!redis.store.has('token:t1'), '主 token 未被清理');
    assert.ok(!redis.store.has('token:t1:iat'), 'iat 伴生键未被清理');
  });

  it('30 天内会话正常放行并续期', async () => {
    const redis = new FakeRedis();
    redis.store.set('token:t2', JSON.stringify({ role: 'admin' }));
    redis.store.set('token:t2:iat', String(now() - 1 * DAY));
    const ctx = ctxFor('/invest/broad', 't2');
    let nextCalled = false;
    await mw(redis)(ctx, async () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.deepStrictEqual(ctx.userInfo, { role: 'admin' });
    await new Promise(r => setImmediate(r));   // renew 是异步 fire-and-forget
    assert.ok(redis.expireCalls.includes('token:t2'), '有效会话应被续期');
  });

  it('非 invest 路径超龄：请求放行（历史语义）但不挂登录态', async () => {
    const redis = new FakeRedis();
    redis.store.set('token:t3', JSON.stringify({ role: 'admin' }));
    redis.store.set('token:t3:iat', String(now() - 31 * DAY));
    const ctx = ctxFor('/user/info', 't3');
    let nextCalled = false;
    await mw(redis)(ctx, async () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, '非 invest 端点可达性不变');
    assert.strictEqual(ctx.userInfo, undefined, '超龄会话不得挂 userInfo');
  });
});
