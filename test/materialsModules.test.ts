import * as assert from 'assert';
import { MaterialsService, parseMaterialModule } from '../src/service/materials';
import { MaterialsHTTPService } from '../src/function/materials';

const civilManifest = {
  version: 2,
  groups: [{ key: 'civil', label: '考公备考', items: [
    { key: 'civil-sprint', label: '国考冲刺速查', updatedAt: '2026-11-11T00:00:00Z', sizeBytes: 100, articleCount: 10 },
    { key: 'civil-sprint-answers', label: '国考冲刺速查 · 答案与解析', kind: 'answers', updatedAt: '2026-11-11T00:00:00Z', sizeBytes: 50, articleCount: 9 },
  ] }],
};

function service() {
  const storage = new Map<string, string>([['materials/civil/manifest.json', JSON.stringify(civilManifest)]]);
  const signed: string[] = [];
  const s = new MaterialsService();
  s.navModel = { findOneBy: async () => assert.fail('非 knowledge 模块不读 nav') } as any;
  s.ossService = {
    getRawText: async (key: string) => storage.get(key) || null,
    signedUrl: (key: string, _e: number, filename: string) => { signed.push(`${key}|${filename}`); return `https://fixture.invalid/${key}`; },
  } as any;
  return { s, signed };
}

function controller(allowed: boolean, userId = 'u1', opts: { purchase?: boolean; now?: string } = {}) {
  const c = new MaterialsHTTPService();
  c.ctx = { userInfo: userId ? { userId, role: 'user' } : undefined } as any;
  c.materialsService = service().s;
  c.entitlementService = { check: async () => ({ allowed }) } as any;
  c.orderService = { getPdfPurchase: async () => (opts.purchase ? { status: 'self_reported' } : null) } as any;
  c.now = () => new Date(opts.now || '2026-11-11T12:00:00+08:00');
  return c;
}

describe('按模块列出与下载资料 PDF', () => {
  it('模块参数只接受白名单，缺省为 knowledge', () => {
    assert.strictEqual(parseMaterialModule(undefined), 'knowledge');
    assert.strictEqual(parseMaterialModule('civil'), 'civil');
    assert.throws(() => parseMaterialModule('../x'));
    assert.throws(() => parseMaterialModule('interview'));
  });

  it('civil 清单读 materials/civil/manifest.json，带上答案册的 kind', async () => {
    const { s } = service();
    const groups = await s.groupedListReady('civil');
    assert.deepStrictEqual(groups[0].items.map(i => [i.key, i.kind]), [['civil-sprint', undefined], ['civil-sprint-answers', 'answers']]);
    assert.deepStrictEqual(await s.groupedListReady('soe'), []);
  });

  it('civil 下载签 materials/civil/<key>.pdf，文件名用清单里的标题', async () => {
    const { s, signed } = service();
    assert.strictEqual(await s.isReady('civil-sprint', 'civil'), true);
    assert.strictEqual(await s.isReady('civil-sprint', 'soe'), false);
    await s.downloadUrl('civil-sprint', 'civil');
    assert.deepStrictEqual(signed, ['materials/civil/civil-sprint.pdf|国考冲刺速查.pdf']);
    await assert.rejects(s.downloadUrl('../evil', 'civil'));
  });

  it('会员可以下载考公资料', async () => {
    const res = await controller(true).download('civil-sprint', 'civil');
    assert.strictEqual(res.success, true);
    assert.match(res.data.url, /materials\/civil\/civil-sprint\.pdf/);
  });

  it('考公资料仅会员：公测免费期、老 ¥9.9 买家都不放行', async () => {
    await assert.rejects(controller(false, 'u2', { purchase: true }).list('civil'), /会员/);
    await assert.rejects(controller(false, 'u2').download('civil-sprint', 'civil'), /会员/);
    await assert.rejects(controller(true, '').list('civil'), /登录/);
  });

  it('知识库资料的资格判断不变：公测期登录即可领取', async () => {
    const c = controller(false, 'u3');
    c.materialsService = { groupedListReady: async (m?: string) => { assert.strictEqual(m ?? 'knowledge', 'knowledge'); return []; } } as any;
    assert.deepStrictEqual(await c.list(), { success: true, data: [] });
  });

  it('公开 product?module=civil 只列册名，不带下载链接', async () => {
    const res = await controller(false, '').product('civil');
    assert.strictEqual(res.data.memberOnly, true);
    assert.strictEqual(res.data.ready, true);
    assert.ok(!/fixture\.invalid/.test(JSON.stringify(res)));
  });

  it('不支持的模块报错', async () => {
    await assert.rejects(controller(true).list('interview'));
  });
});
