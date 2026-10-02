import * as assert from 'assert';
import { OrderService } from '../src/service/order';
import { MaterialsHTTPService } from '../src/function/materials';
import { UserEntity } from '../src/entity/user';

const groups = [{ key: 'agent', label: 'Agent', items: [{ key: 'agent-basics', label: 'Agent 基础', ready: true, updatedAt: '2026-10-02', sizeBytes: 100, articleCount: 2 }] }];
function orders() {
  const rows: any[] = [];
  const locks: any[] = [];
  let queue = Promise.resolve();
  const repo = {
    findOneBy: async (where: any) => rows.find(r => Object.entries(where).every(([k, v]) => r[k] === v)) || null,
    create: (data: any) => ({ ...data }),
    save: async (data: any) => { const row = { id: rows.length + 1, ...data }; rows.push(row); return row; },
  };
  const users = { findOne: async (options: any) => { locks.push(options); return options.where.phoneNumber === 'u1' ? { id: 1 } : null; } };
  const manager = { getRepository: (entity: any) => entity === UserEntity ? users : repo };
  const service = new OrderService();
  service.orderModel = { ...repo, manager: { transaction: async (fn: any) => {
    const prior = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await fn(manager); } finally { release(); }
  } } } as any;
  return { service, rows, locks };
}
function controller(userId = 'u1') {
  const c = new MaterialsHTTPService();
  c.ctx = { userInfo: userId ? { userId, role: 'user' } : undefined } as any;
  c.entitlementService = { check: async () => ({ allowed: false }) } as any;
  c.materialsService = { groupedListReady: async () => groups, legacyGift: async () => null, isReady: async (key: string) => key === 'agent-basics', downloadUrl: async (key: string) => `https://fixture.invalid/${key}.pdf` } as any;
  return c;
}
describe('Agent PDF 自报支付：范围、身份与幂等', () => {
  it('990分当前Agent清单可购买，公开目录没有签名交付链接或到账核验承诺', async () => {
    const r = await controller().product();
    assert.strictEqual(r.data.priceCents, 990);
    assert.strictEqual(r.data.purchasingEnabled, true);
    assert.strictEqual(r.data.paymentBasis, 'user_self_reported');
    assert.strictEqual(r.data.bankVerified, false);
    assert.deepStrictEqual(r.data.groups, groups);
    assert.ok(!/https?:\/\//.test(JSON.stringify(r)));
  });
  it('没有生成资料时不开放购买，也不写订单', async () => {
    const c = controller(); c.materialsService.groupedListReady = async () => [];
    c.orderService = { reportPdfPurchase: async () => assert.fail('no order') } as any;
    assert.strictEqual((await c.product()).data.purchasingEnabled, false);
    await assert.rejects(c.confirmPurchase({}));
  });
  it('访客不能用body身份、伪造价格和付款字段解锁', async () => {
    const c = controller('');
    c.orderService = { reportPdfPurchase: async () => assert.fail('no order') } as any;
    await assert.rejects(c.confirmPurchase({ userId: 'victim', amount: 0.01, status: 'paid' } as any));
  });
  it('无效token不写订单；有效token身份来自Redis而非body', async () => {
    const c = controller('');
    c.ctx = { headers: { token: 'fixture-token' } } as any;
    c.redisService = { get: async () => null } as any;
    c.orderService = { reportPdfPurchase: async () => assert.fail('invalid token') } as any;
    await assert.rejects(c.confirmPurchase({}));
    c.redisService = { get: async (key: string) => key === 'token:fixture-token' ? JSON.stringify({ userId: 'u1', role: 'user' }) : null } as any;
    let resolved = '';
    c.orderService = { reportPdfPurchase: async (id: string) => { resolved = id; return { created: true }; } } as any;
    await c.confirmPurchase({ userId: 'victim' } as any);
    assert.strictEqual(resolved, 'u1');
  });
  it('确认仅使用登录身份，金额/商品/状态由服务端固定', async () => {
    const c = controller(); let args: any[] = [];
    c.orderService = { reportPdfPurchase: async (...a: any[]) => { args = a; return { created: true, status: 'self_reported' }; } } as any;
    await c.confirmPurchase({ userId: 'victim', amount: 0.01, sku: 'member', status: 'paid', channel: 'direct' } as any);
    assert.deepStrictEqual(args, ['u1', 'direct']);
  });
  it('同用户并发确认只存一笔self_reported，重试不重复计数，不写paid/会员', async () => {
    const { service, rows, locks } = orders();
    const r = await Promise.all([service.reportPdfPurchase('u1'), service.reportPdfPurchase('u1')]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'self_reported');
    assert.strictEqual(rows[0].type, 'pdf');
    assert.strictEqual(rows[0].amount, 9.9);
    assert.strictEqual(r.filter(x => x.created).length, 1);
    assert.strictEqual(r[0].order.orderNo, r[1].order.orderNo);
    assert.ok(locks.every(x => x.lock.mode === 'pessimistic_write'));
    assert.ok(!rows[0].paymentVerifiedAt && !rows[0].isMember);
  });
  it('不接受不存在的账号，失败不落单', async () => {
    const { service, rows } = orders();
    await assert.rejects(service.reportPdfPurchase('unknown'));
    assert.strictEqual(rows.length, 0);
  });
  it('刷新/重新打开后同账号仍能获取，另一个账号不共享资格', async () => {
    const { service } = orders(); await service.reportPdfPurchase('u1');
    assert.ok(await service.getPdfPurchase('u1'));
    assert.strictEqual(await service.getPdfPurchase('u2'), null);
    const c = controller(); c.orderService = service;
    const status = await c.purchaseStatus();
    assert.strictEqual(status.data.canDownload, true);
    assert.strictEqual(status.data.basis, 'self_reported');
    assert.deepStrictEqual((await c.list()).data, groups);
    assert.strictEqual((await c.download('agent-basics')).data.url, 'https://fixture.invalid/agent-basics.pdf');
  });
  it('拒绝不存在/未生成的PDF，不签发任意对象路径', async () => {
    const c = controller(); c.orderService = { getPdfPurchase: async () => ({ status: 'self_reported' }) } as any;
    await assert.rejects(c.download('../../secret'));
  });
  it('已有有效会员不必重买、不新增事件，旧PDF仍可获取', async () => {
    const c = controller(); c.entitlementService.check = async () => ({ allowed: true });
    c.orderService = { reportPdfPurchase: async () => assert.fail('member must not buy') } as any;
    assert.strictEqual((await c.confirmPurchase({})).data.created, false);
    assert.deepStrictEqual((await c.list()).data, groups);
  });
  it('退款/无效状态不继续解锁，也不能自报覆盖退款历史', async () => {
    const { service, rows } = orders(); await service.reportPdfPurchase('u1'); rows[0].status = 'refunded';
    assert.strictEqual(await service.getPdfPurchase('u1'), null);
    await assert.rejects(service.reportPdfPurchase('u1'));
    assert.strictEqual(rows.length, 1);
  });
});
