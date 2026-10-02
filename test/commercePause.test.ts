import * as assert from 'assert';
import { OrderService } from '../src/service/order';
import { UserService } from '../src/service/user';
import { ProfileHTTPService } from '../src/function/profile';
import { MaterialsHTTPService } from '../src/function/materials';
import { EntitlementService } from '../src/service/entitlement';
import { BookOrderService } from '../src/service/bookOrder';

describe('9.9 PDF / 会员停售安全边界', () => {
  it('遗留书籍订单也不能由客户端伪造核验字段', async () => {
    const svc = new BookOrderService();
    let saved: any;
    svc.bookOrderModel = { create: (x: any) => x, save: async (x: any) => { saved = x; return x; } } as any;
    await svc.create({ userId: 'u1', bookId: 1, bookTitle: 'old', versionType: 'pdf', amount: 0.01,
      paymentVerifiedAt: new Date(), paymentReference: 'forged' } as any);
    assert.ok(!saved.paymentVerifiedAt && !saved.paymentReference);
  });
  it('遗留确认接口不能把书籍订单自报为已付款', async () => {
    const svc = new BookOrderService();
    const writes: any[] = [];
    svc.bookOrderModel = { findOne: async () => ({ id: 1, status: 'pending' }), update: async (...args: any[]) => writes.push(args) } as any;
    await assert.rejects(svc.confirm('old-order'));
    assert.deepStrictEqual(writes, []);
  });
  it('旧通用订单入口仍不能伪造 paid 或商品金额', async () => {
    const svc = new OrderService();
    const writes: any[] = [];
    svc.orderModel = { create: (x: any) => x, save: async (x: any) => writes.push(x) } as any;
    await assert.rejects(svc.create({ userId: 'u1', type: 'pdf', name: '全部21册', amount: 0.01 }));
    assert.deepStrictEqual(writes, []);
  });

  it('停售后直接调用会员开通服务也不能续期、写权益或订单', async () => {
    const svc = new UserService();
    const user = { isMember: true, memberDate: '2099-01-01 00:00:00', toVO() { return { isMember: this.isMember }; } };
    const original = { ...user };
    const writes: any[] = [];
    svc.userModel = { findOneBy: async () => user, save: async (x: any) => writes.push(x) } as any;
    svc.entitlementService = { grantFromOrder: async () => writes.push('entitlement') } as any;
    (svc as any).orderService = { create: async () => writes.push('order') };
    await assert.rejects(svc.activateMembership('u1', 'yearly'), /暂停/);
    assert.deepStrictEqual(user, original);
    assert.deepStrictEqual(writes, []);
  });

  it('旧订单接口不接受 body.userId 冒充登录用户', async () => {
    const svc = new ProfileHTTPService();
    svc.ctx = {} as any;
    const writes: any[] = [];
    svc.orderService = { create: async (x: any) => writes.push(x) } as any;
    await assert.rejects(svc.recordOrder({ userId: 'victim', type: 'pdf', amount: 9.9 }));
    assert.deepStrictEqual(writes, []);
  });

  it('新注册不再赠送试用，也不采信客户端伪造的会员标记', async () => {
    const svc = new UserService();
    let saved: any;
    let trials = 0;
    svc.userModel = { countBy: async () => 0, save: async (x: any) => { saved = { ...x }; } } as any;
    svc.entitlementService = { grantTrial: async () => { trials++; } } as any;
    svc.tokenConfig = { expire: 60 } as any;
    const multi = { set: () => multi, expire: () => multi, exec: async () => [] };
    svc.redisService = { multi: () => multi } as any;
    await svc.createUser({ phoneNumber: 'u-new', password: 'test-only', toEntity: () => ({ isMember: true, memberDate: '2099-01-01' }) } as any);
    assert.strictEqual(saved.isMember, false);
    assert.strictEqual(trials, 0);
  });

  it('已有有效会员继续领取原来21册范围内的资料', async () => {
    const entitlement = new EntitlementService();
    entitlement.membershipConfig = {};
    entitlement.entModel = { findOne: async () => ({ userId: 'u1', expireAt: new Date(Date.now() + 86400000) }) } as any;
    const svc = new MaterialsHTTPService();
    svc.ctx = { userInfo: { userId: 'u1', role: 'user' } } as any;
    svc.entitlementService = entitlement;
    svc.materialsService = { groupedListReady: async () => [{ key: 'agent', items: [{ key: 'rag' }] }] } as any;
    assert.deepStrictEqual(await svc.list(), { success: true, data: [{ key: 'agent', items: [{ key: 'rag' }] }] });
  });

  it('非会员不能因9.9商品展示而领取全部会员PDF', async () => {
    const svc = new MaterialsHTTPService();
    svc.ctx = { userInfo: { userId: 'u2', role: 'user' } } as any;
    svc.entitlementService = { check: async () => ({ allowed: false }) } as any;
    svc.orderService = { getPdfPurchase: async () => null } as any;
    svc.materialsService = { groupedListReady: async () => assert.fail('不得读取交付清单') } as any;
    await assert.rejects(svc.list());
  });

  it('公开商品按当前实际清单展示，空清单不能付款，不泄漏下载链接', async () => {
    const svc = new MaterialsHTTPService();
    svc.materialsService = { groupedListReady: async () => [], legacyGift: async () => null } as any;
    const response = await svc.product();
    assert.strictEqual(response.data.priceCents, 990);
    assert.strictEqual(response.data.purchaseType, 'one_time');
    assert.strictEqual(response.data.purchasingEnabled, false);
    assert.strictEqual(response.data.includesMembership, false);
    assert.strictEqual(response.data.scopeConfirmed, true);
    assert.strictEqual(response.data.scopeStatus, 'confirmed');
    assert.strictEqual(response.data.bankVerified, false);
    assert.ok(!/2024|180\+|12 万字|前端面试/.test(JSON.stringify(response)));
    assert.ok(!/https?:\/\//.test(JSON.stringify(response)));
  });

});
