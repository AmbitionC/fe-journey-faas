import * as assert from 'assert';
import { AuthMiddleware } from '../../src/middleware/auth';

/**
 * /invest/visit（投资站访问记录，2026-10-23）：普通登录用户必须能 POST，
 * 否则投资站每次打开都会吃一个 403；其它 admin 端点对普通用户仍然 403。
 */
class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) { return this.store.has(k) ? this.store.get(k) : null; }
  async set(k: string, v: string, ..._args: any[]) {
    if (_args.includes('NX') && this.store.has(k)) return null;
    this.store.set(k, v); return 'OK';
  }
  async expire() { return 1; }
  async del() { return 1; }
}

function run(method: string, path: string, role: string) {
  const redis = new FakeRedis();
  redis.store.set('token:u', JSON.stringify({ userId: '13800000000', role }));
  const m = new AuthMiddleware();
  (m as any).redisService = redis;
  (m as any).tokenConfig = { expire: 7 * 86400 };
  const ctx = { method, path, header: { token: 'u' } } as any;
  let nextCalled = false;
  return m.resolve()(ctx, async () => { nextCalled = true; })
    .then(() => ({ nextCalled, err: null as any }))
    .catch((err: any) => ({ nextCalled, err }));
}

describe('auth /invest/visit 普通用户放行', () => {
  it('普通用户 POST /invest/visit 放行', async () => {
    const r = await run('POST', '/invest/visit', 'user');
    assert.strictEqual(r.err, null);
    assert.strictEqual(r.nextCalled, true);
  });

  it('普通用户 GET /invest/visit 不放行（只开 POST）', async () => {
    const r = await run('GET', '/invest/visit', 'user');
    assert.strictEqual(r.nextCalled, false);
    assert.strictEqual(r.err?.status ?? r.err?.code, 403);
  });

  it('普通用户访问 admin 端点仍然 403', async () => {
    const r = await run('GET', '/invest/plan', 'user');
    assert.strictEqual(r.nextCalled, false);
    assert.strictEqual(r.err?.status ?? r.err?.code, 403);
  });
});
