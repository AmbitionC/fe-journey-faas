import * as assert from 'assert';
import { gunzipSync } from 'zlib';
import { acceptsGzip, buildDatasetBody } from '../src/common/datasetBody';
import { AuthMiddleware } from '../src/middleware/auth';

describe('前端数据集响应体（宽基历史回测走库，2026-10-27）', () => {
  const payload = JSON.stringify({ legs: [{ name: '沪深300', end: '20261023' }], note: '中文' });

  it('信封与其它接口一致，原文与压缩体解出同一份数据', () => {
    const { raw, gz } = buildDatasetBody(payload);
    const a = JSON.parse(raw.toString('utf8'));
    const b = JSON.parse(gunzipSync(gz).toString('utf8'));
    assert.deepStrictEqual(a, { success: true, data: JSON.parse(payload) });
    assert.deepStrictEqual(b, a);
  });

  it('Accept-Encoding 判定', () => {
    assert.strictEqual(acceptsGzip('gzip, deflate, br'), true);
    assert.strictEqual(acceptsGzip('br;q=1.0, gzip;q=0.8'), true);
    assert.strictEqual(acceptsGzip('br'), false);
    assert.strictEqual(acceptsGzip(''), false);
    assert.strictEqual(acceptsGzip(undefined), false);
  });
});

class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.has(k) ? this.store.get(k) : null;
  }
  async set(k: string, v: string, ..._args: any[]) {
    if (_args.includes('NX') && this.store.has(k)) return null;
    this.store.set(k, v);
    return 'OK';
  }
  async expire() {
    return 1;
  }
  async del() {
    return 1;
  }
}

function run(method: string, path: string, role: string) {
  const redis = new FakeRedis();
  redis.store.set('token:u', JSON.stringify({ userId: '13800000000', role }));
  const m = new AuthMiddleware();
  (m as any).redisService = redis;
  (m as any).tokenConfig = { expire: 7 * 86400 };
  const ctx = { method, path, header: { token: 'u' } } as any;
  let nextCalled = false;
  return m
    .resolve()(ctx, async () => {
      nextCalled = true;
    })
    .then(() => ({ nextCalled, err: null as any }))
    .catch((err: any) => ({ nextCalled, err }));
}

describe('auth /invest/broad/history 普通用户可读（市场级公开数据）', () => {
  it('普通用户 GET 放行', async () => {
    const r = await run('GET', '/invest/broad/history', 'user');
    assert.strictEqual(r.err, null);
    assert.strictEqual(r.nextCalled, true);
  });
  it('普通用户 POST 不放行', async () => {
    const r = await run('POST', '/invest/broad/history', 'user');
    assert.strictEqual(r.nextCalled, false);
    assert.strictEqual(r.err?.status, 403);
  });
});
