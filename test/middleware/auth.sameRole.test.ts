import * as assert from 'assert';
import { AuthMiddleware } from '../../src/middleware/auth';

/**
 * owner 2026-11-04「我的账号和普通账号有没有啥区别，把这个做彻底」：
 * /invest/* 对管理员与普通用户一视同仁——管理员不再有专属端点（计划/持仓/投顾/复盘/套利/美股/模型），
 * 普通用户能用的管理员也照常能用。管理员身份只代表后台（/mcp/admin、内容管理）权限。
 */
class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) { return this.store.has(k) ? this.store.get(k) : null; }
  async set(k: string, v: string) { this.store.set(k, v); return 'OK'; }
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
    .then(() => ({ nextCalled, status: 200 }))
    .catch((err: any) => ({ nextCalled, status: err?.status ?? err?.code }));
}

const CASES: [string, string][] = [
  ['GET', '/invest/plan'], ['GET', '/invest/holdings/current'], ['GET', '/invest/overview'],
  ['GET', '/invest/advisor/reco'], ['GET', '/invest/arbitrage/ledger'], ['GET', '/invest/us/plan'],
  ['GET', '/invest/model/registry'], ['GET', '/invest/alerts'], ['GET', '/invest/health'],
  ['GET', '/invest/broad'], ['GET', '/invest/fear/latest'], ['GET', '/invest/follow'],
  ['POST', '/invest/follow/profile'], ['POST', '/invest/alertPref'], ['POST', '/invest/visit'],
];

describe('auth /invest/* 管理员与普通用户一致', () => {
  for (const [method, path] of CASES) {
    it(`${method} ${path}`, async () => {
      const admin = await run(method, path, 'admin');
      const user = await run(method, path, 'user');
      assert.deepStrictEqual(admin, user);
    });
  }
  it('原管理员专属端点对管理员也 403', async () => {
    const r = await run('GET', '/invest/holdings/current', 'admin');
    assert.strictEqual(r.nextCalled, false);
    assert.strictEqual(r.status, 403);
  });
});
