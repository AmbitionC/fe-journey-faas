import * as assert from 'assert';
import { KidsHTTPService } from '../src/function/kids';

/** 只测登录门槛和限流：Redis、OSS 都用假的 */
function makeService(opts: { token?: string; users?: Record<string, string>; counts?: Record<string, number> }) {
  const svc = new KidsHTTPService();
  const counts = opts.counts || {};
  (svc as any).ctx = { header: opts.token ? { token: opts.token } : {}, headers: {}, ip: '' };
  (svc as any).redisService = {
    get: async (k: string) => (opts.users || {})[k] ?? null,
    incr: async (k: string) => (counts[k] = (counts[k] || 0) + 1),
    expire: async () => 1,
    set: async () => 'OK',
  };
  (svc as any).ossService = {
    signedUrl: (key: string) => `http://oss/${key}?sig`,
    getRawText: async (key: string) =>
      key.endsWith('shelf.json')
        ? JSON.stringify([{ id: 'ort-l1-13', cover: 'p01.webp' }])
        : JSON.stringify({ id: 'ort-l1-13', cover: 'p01.webp', pages: [{ image: 'p01.webp', lines: [{ en: 'Hi', audio: 'l01.mp3' }] }] }),
  };
  return { svc, counts };
}

describe('栗栗学英语 牛津树要登录才能读', () => {
  it('没登录读书：401 请先登录，不签任何地址', async () => {
    const { svc } = makeService({});
    await assert.rejects(() => svc.ortBook('ort-l1-13'), (e: any) => /请先登录/.test(e.message) || e.code === 401);
  });

  it('token 不对也算没登录', async () => {
    const { svc } = makeService({ token: 'bad', users: {} });
    await assert.rejects(() => svc.ortBook('ort-l1-13'));
  });

  it('登录后能读，页图和音频都是签名地址', async () => {
    const { svc } = makeService({ token: 't1', users: { 'token:t1': JSON.stringify({ userId: 'u1' }) } });
    const res: any = await svc.ortBook('ort-l1-13');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.pages[0].image, 'https://oss/little-circle-web/ort/l1/ort-l1-13/p01.webp?sig');
    assert.strictEqual(res.data.pages[0].lines[0].audio, 'https://oss/little-circle-web/ort/l1/ort-l1-13/l01.mp3?sig');
  });

  it('书架不用登录，只签封面', async () => {
    const { svc } = makeService({});
    const res: any = await svc.ortShelf();
    assert.strictEqual(res.data[0].cover, 'https://oss/little-circle-web/ort/l1/ort-l1-13/p01.webp?sig');
  });

  it('同一个账号 10 分钟超过 300 次就限流', async () => {
    const { svc, counts } = makeService({ token: 't1', users: { 'token:t1': JSON.stringify({ userId: 'u1' }) } });
    const win = Math.floor(Date.now() / 1000 / 600);
    counts[`kids:ort:urate:${win}:u1`] = 300;
    await assert.rejects(() => svc.ortBook('ort-l1-13'), (e: any) => /太频繁/.test(e.message));
  });
});
