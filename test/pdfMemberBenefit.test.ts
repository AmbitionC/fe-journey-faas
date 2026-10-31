import * as assert from 'assert';
import { MaterialsHTTPService } from '../src/function/materials';
import { EntitlementService } from '../src/service/entitlement';
import { OrderService } from '../src/service/order';
import { legacyPdfOrderNo, pdfFreeClaimActive } from '../src/common/commerce';

/**
 * 2026-11-01 起知识点 PDF 是会员权益（owner 2026-10-31 定）：¥9.9 单卖下架，
 * 下载资格 = 会员权益（网站存量会员 / Skill 会员）→ 老 ¥9.9 买家 → 公测免费期已登录。
 */
const FREE_PHASE = new Date('2026-11-15T00:00:00+08:00');
const PAID_PHASE = new Date('2026-12-05T00:00:00+08:00');
const groups = [{ key: 'agent', label: 'Agent', items: [{ key: 'agent-basics', label: 'Agent 基础', ready: true, updatedAt: '2026-10-02', sizeBytes: 100, articleCount: 2 }] }];

function controller(opts: { userId?: string; member?: boolean; legacy?: boolean; now?: Date } = {}) {
  const c = new MaterialsHTTPService();
  const userId = opts.userId ?? 'u1';
  c.ctx = { userInfo: userId ? { userId, role: 'user' } : undefined } as any;
  c.now = () => opts.now || PAID_PHASE;
  c.entitlementService = { check: async () => ({ allowed: !!opts.member }) } as any;
  c.orderService = { getPdfPurchase: async (id: string) => opts.legacy && id === userId ? { orderNo: legacyPdfOrderNo(id), status: 'self_reported', bankVerified: false } : null } as any;
  c.materialsService = { groupedListReady: async () => groups, legacyGift: async () => null, isReady: async (key: string) => key === 'agent-basics', downloadUrl: async (key: string) => `https://fixture.invalid/${key}.pdf` } as any;
  return c;
}

describe('知识点 PDF 并入会员权益', () => {
  it('商品接口：会员权益口径、会员价来自定价表、不出现 ¥9.9 与收款文案', async () => {
    const r = (await controller({ now: PAID_PHASE }).product()).data;
    assert.strictEqual(r.purchaseType, 'membership');
    assert.strictEqual(r.saleClosed, true);
    assert.strictEqual(r.purchasingEnabled, false);
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.legacy.priceCents, 990);
    assert.strictEqual(r.membership.phase.id, 'half');
    assert.strictEqual(r.membership.freeClaim, false);
    const month = r.membership.plans.find((p: any) => p.sku === 'member_month');
    assert.strictEqual(month.listPrice, 29);
    assert.strictEqual(month.price, 14.5);
    assert.strictEqual(month.purchasable, true);
    assert.ok(!/收款码|我已支付|单次购买/.test(JSON.stringify(r)));
    assert.ok(!/https?:\/\//.test(JSON.stringify(r)));
  });
  it('公测免费期：商品接口标 freeClaim，会员卡不可购买', async () => {
    const r = (await controller({ now: FREE_PHASE }).product()).data;
    assert.strictEqual(r.membership.phase.id, 'free');
    assert.strictEqual(r.membership.freeClaim, true);
    assert.ok(r.membership.plans.every((p: any) => p.purchasable === false && p.price === 0));
    assert.ok(r.message.includes('公测期'));
    assert.strictEqual(pdfFreeClaimActive(FREE_PHASE), true);
    assert.strictEqual(pdfFreeClaimActive(PAID_PHASE), false);
  });
  it('会员（含 Skill 会员）可领，basis=member', async () => {
    const c = controller({ member: true });
    const status = (await c.purchaseStatus()).data;
    assert.deepStrictEqual([status.canDownload, status.basis, status.needsLogin], [true, 'member', false]);
    assert.strictEqual(status.saleClosed, true);
    assert.deepStrictEqual((await c.list()).data, groups);
    assert.strictEqual((await c.download('agent-basics')).data.url, 'https://fixture.invalid/agent-basics.pdf');
  });
  it('老 ¥9.9 买家资格永久保留，basis=legacy_purchase 且带订单回执', async () => {
    const c = controller({ legacy: true });
    const status = (await c.purchaseStatus()).data;
    assert.strictEqual(status.canDownload, true);
    assert.strictEqual(status.basis, 'legacy_purchase');
    assert.strictEqual(status.order.status, 'self_reported');
    assert.deepStrictEqual((await c.list()).data, groups);
  });
  it('公测免费期登录即可领，basis=free_phase；期满后同一用户被拒并导向会员', async () => {
    const free = controller({ now: FREE_PHASE });
    assert.strictEqual((await free.purchaseStatus()).data.basis, 'free_phase');
    assert.deepStrictEqual((await free.list()).data, groups);
    const paid = controller({ now: PAID_PHASE });
    const status = (await paid.purchaseStatus()).data;
    assert.deepStrictEqual([status.canDownload, status.basis, status.needsLogin], [false, null, false]);
    assert.strictEqual(status.memberUrl, '/developer');
    await assert.rejects(paid.list(), /会员/);
    await assert.rejects(paid.download('agent-basics'), /会员/);
  });
  it('游客：needsLogin，公测期也不能下', async () => {
    const c = controller({ userId: '', now: FREE_PHASE });
    const status = (await c.purchaseStatus()).data;
    assert.deepStrictEqual([status.canDownload, status.needsLogin], [false, true]);
    await assert.rejects(c.list(), /登录/);
    await assert.rejects(c.confirmPurchase({}), /登录/);
  });
  it('旧「我已支付」接口不再写订单：无资格者报单卖已下架，有资格者返回可下载', async () => {
    const paid = controller({ now: PAID_PHASE });
    await assert.rejects(paid.confirmPurchase({ amount: 9.9, status: 'paid' } as any), /不再单独售卖/);
    const legacy = (await controller({ legacy: true }).confirmPurchase({})).data;
    assert.deepStrictEqual([legacy.created, legacy.canDownload, legacy.basis], [false, true, 'legacy_purchase']);
    const member = (await controller({ member: true }).confirmPurchase({})).data;
    assert.deepStrictEqual([member.created, member.canDownload, member.basis], [false, true, 'member']);
  });
  it('订单服务不再提供自报写入，旧通用入口对 pdf/member 都拒绝', async () => {
    const svc = new OrderService();
    const writes: any[] = [];
    svc.orderModel = { create: (x: any) => x, save: async (x: any) => writes.push(x) } as any;
    assert.strictEqual(typeof (svc as any).reportPdfPurchase, 'undefined');
    await assert.rejects(svc.create({ userId: 'u1', type: 'pdf', name: 'x', amount: 9.9 }), /不再单独售卖/);
    await assert.rejects(svc.create({ userId: 'u1', type: 'member', name: 'x', amount: 29 }), /Skill/);
    assert.deepStrictEqual(writes, []);
  });
});

describe('权益网关：Skill 会员即网站会员', () => {
  function entitlement(rows: any[] | Error, entRow: any = null) {
    const e = new EntitlementService();
    e.membershipConfig = {};
    e.entModel = {
      findOne: async () => entRow,
      manager: { query: async (sql: string, params: any[]) => {
        assert.ok(/mcp_account/.test(sql) && /tier_expire_at > NOW\(\)/.test(sql) && /'starter'/.test(sql));
        assert.deepStrictEqual(params, ['u1']);
        if (rows instanceof Error) throw rows;
        return rows;
      } },
    } as any;
    return e;
  }
  it('有效 Skill 会员 → isMember 与 materials_pdf 放行，到期日取自账户', async () => {
    const e = entitlement([{ tier_expire_at: '2027-01-01 00:00:00' }]);
    assert.strictEqual(await e.isMember('u1'), true);
    assert.strictEqual((await e.check('u1', 'materials_pdf')).allowed, true);
    assert.strictEqual((await e.currentExpiry('u1'))!.getFullYear(), 2027);
  });
  it('无 Skill 会员行 / 表不存在 → 按非会员，不白送', async () => {
    for (const e of [entitlement([]), entitlement(new Error("Table 'mcp_account' doesn't exist"))]) {
      assert.strictEqual(await e.isMember('u1'), false);
      assert.strictEqual((await e.check('u1', 'materials_pdf')).allowed, false);
      assert.strictEqual(await e.currentExpiry('u1'), null);
    }
  });
  it('权益记录与 Skill 会员并存时到期日取较晚者；游客不查库', async () => {
    const e = entitlement([{ tier_expire_at: '2027-01-01 00:00:00' }], { expireAt: new Date('2028-01-01T00:00:00Z') });
    assert.strictEqual((await e.currentExpiry('u1'))!.getFullYear(), 2028);
    const guest = new EntitlementService();
    guest.membershipConfig = {};
    guest.entModel = { manager: { query: async () => assert.fail('guest must not query') } } as any;
    assert.strictEqual(await guest.skillMembershipExpiry('guest:1.2.3.4'), null);
    assert.strictEqual(await guest.skillMembershipExpiry(''), null);
  });
});
