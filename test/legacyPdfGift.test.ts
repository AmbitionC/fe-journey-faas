import * as assert from 'assert';
import { readFileSync } from 'fs';
import { MaterialsService } from '../src/service/materials';
import { MaterialsHTTPService } from '../src/function/materials';
import { LEGACY_PDF_GIFT, LEGACY_PDF_KEY, LEGACY_PDF_METADATA_KEY, LEGACY_PDF_SHA256, LEGACY_PDF_SIZE, assertLegacyPdf } from '../src/common/legacyPdfGift';

const pdfKey = `materials/knowledge/${LEGACY_PDF_KEY}.pdf`;
const metadata = { key: LEGACY_PDF_KEY, sha256: LEGACY_PDF_SHA256, sizeBytes: LEGACY_PDF_SIZE, updatedAt: '2026-10-02T00:00:00Z' };
const mainGroup = { key: 'agent', label: 'Agent', items: [{ key: 'agent-basics', label: 'Agent 基础', updatedAt: '2026-10-02T00:00:00Z', sizeBytes: 100, articleCount: 1 }] };

function materials() {
  const storage = new Map<string, string>([
    ['materials/knowledge/manifest.json', JSON.stringify({ version: 2, groups: [mainGroup] })],
    [LEGACY_PDF_METADATA_KEY, JSON.stringify(metadata)],
  ]);
  const writes: string[] = [];
  const service = new MaterialsService();
  service.navModel = { findOneBy: async () => ({ navData: [] }) } as any;
  service.ossService = {
    getRawText: async (key: string) => storage.get(key) || null,
    rawMeta: async (key: string) => key === pdfKey ? { lastModified: '2026-10-02' } : null,
    signedUrl: (key: string, expires: number, filename: string) => { assert.strictEqual(expires, 86400); return `https://fixture.invalid/${key}?filename=${encodeURIComponent(filename)}`; },
    putPrivate: async (key: string, buf: Buffer, contentType: string) => { assert.strictEqual(key, pdfKey); assert.strictEqual(contentType, 'application/pdf'); writes.push(key); return buf.length; },
    putRawText: async (key: string, data: string) => { writes.push(key); storage.set(key, data); },
  } as any;
  return { service, storage, writes };
}
function controller(userId: string, allowed: boolean, ownPurchase: boolean) {
  const { service } = materials();
  const c = new MaterialsHTTPService();
  c.ctx = { userInfo: userId ? { userId, role: 'user' } : undefined } as any;
  c.materialsService = service;
  c.entitlementService = { check: async () => ({ allowed }) } as any;
  c.orderService = { getPdfPurchase: async (id: string) => ownPurchase && id === userId ? { status: 'self_reported' } : null, reportPdfPurchase: async () => assert.fail('gift must not create orders') } as any;
  return c;
}

describe('2024 年原版前端 PDF 免费附赠', () => {
  it('资料缺失、元数据损坏/不匹配、对象缺失时不显示可领取状态', async () => {
    const { service, storage } = materials();
    for (const raw of ['', 'invalid json', JSON.stringify({ ...metadata, sha256: 'wrong' }), JSON.stringify({ ...metadata, sizeBytes: 365 }), JSON.stringify({ ...metadata, updatedAt: 'invalid date' })]) {
      storage.set(LEGACY_PDF_METADATA_KEY, raw);
      assert.strictEqual(await service.legacyGift(), null);
      assert.strictEqual(await service.isReady(LEGACY_PDF_KEY), false);
    }
    storage.set(LEGACY_PDF_METADATA_KEY, JSON.stringify(metadata));
    service.ossService.rawMeta = async () => null;
    assert.strictEqual(await service.legacyGift(), null);
  });
  it('Agent 目录与免费附赠分开，勘误指向合并 PDF 的正确页码', async () => {
    const c = controller('', false, false);
    const offer = (await c.product()).data;
    assert.strictEqual(offer.priceCents, 990);
    assert.strictEqual(offer.gift.priceCents, 0);
    assert.strictEqual(offer.gift.pageCount, 365);
    assert.strictEqual(offer.gift.referenceOnly, true);
    assert.deepStrictEqual(offer.gift.errata.map((it: any) => it.page), [185, 186, 187]);
    assert.strictEqual(offer.groups.flatMap((g: any) => g.items).length, 1);
    assert.ok(!JSON.stringify(offer).includes('fixture.invalid'));
  });
  it('附赠文件就绪不能单独触发 Agent 商品售卖', async () => {
    const c = controller('', false, false);
    c.materialsService.groupedListReady = async () => [];
    const offer = (await c.product()).data;
    assert.ok(offer.gift);
    assert.strictEqual(offer.purchasingEnabled, false);
  });
  it('管理员清单提供固定附赠分类，未上传时标为未生成', async () => {
    const { service, storage } = materials();
    storage.delete(LEGACY_PDF_METADATA_KEY);
    const groups = await service.groupedList();
    assert.strictEqual(groups.find(g => g.key === 'historical-gift')!.items[0].ready, false);
    assert.strictEqual(groups.find(g => g.key === 'historical-gift')!.items[0].key, LEGACY_PDF_KEY);
  });
  it('现有会员和已单次领取者复用原交付资格，无新订单或会员写入', async () => {
    for (const c of [controller('old-member', true, false), controller('buyer', false, true)]) {
      const result = await c.download(LEGACY_PDF_KEY);
      assert.strictEqual(result.data.expiresInSec, 86400);
      assert.ok(result.data.url.includes(pdfKey));
      assert.ok(decodeURIComponent(result.data.url).includes(LEGACY_PDF_GIFT.label));
    }
  });
  it('游客和未取得资格的其他账号不能取得签名链接', async () => {
    for (const c of [controller('', false, false), controller('other', false, false)]) await assert.rejects(c.download(LEGACY_PDF_KEY));
  });
  it('附赠仍未上传时，即使有权益也拒绝下载', async () => {
    const c = controller('buyer', false, true);
    c.materialsService.ossService.getRawText = async () => null;
    await assert.rejects(c.download(LEGACY_PDF_KEY));
  });
  it('拒绝不同 PDF，失败不会写对象、元数据或 Agent manifest', async () => {
    const { service, writes } = materials();
    await assert.rejects(service.adminUpload(LEGACY_PDF_KEY, Buffer.from('%PDF-1.4 wrong file')));
    assert.deepStrictEqual(writes, []);
  });
  // 原 PDF 不进公开 Git。发布者本地用已批准的文件跑完整字节上传链测试。
  const withOriginal = process.env.LEGACY_PDF_TEST_PATH ? it : it.skip;
  withOriginal('原文件哈希正确，先私有上传，再发布独立元数据，不改 Agent manifest', async () => {
    const buf = readFileSync(process.env.LEGACY_PDF_TEST_PATH!);
    assertLegacyPdf(buf);
    const { service, storage, writes } = materials();
    storage.delete(LEGACY_PDF_METADATA_KEY);
    const originalManifest = storage.get('materials/knowledge/manifest.json');
    const result = await service.adminUpload(LEGACY_PDF_KEY, buf);
    assert.strictEqual(result.ready, true);
    assert.deepStrictEqual(writes, [pdfKey, LEGACY_PDF_METADATA_KEY]);
    assert.strictEqual(storage.get('materials/knowledge/manifest.json'), originalManifest);
    assert.ok(await service.legacyGift());
  });
  withOriginal('原文件上传失败时不发布附赠元数据', async () => {
    const { service, writes } = materials();
    service.ossService.putPrivate = async () => { throw new Error('fixture upload denied'); };
    await assert.rejects(service.adminUpload(LEGACY_PDF_KEY, readFileSync(process.env.LEGACY_PDF_TEST_PATH!)));
    assert.deepStrictEqual(writes, []);
  });
});
