import * as assert from 'assert';
import { OrderService } from '../src/service/order';
import { MaterialsHTTPService } from '../src/function/materials';
import { UserEntity } from '../src/entity/user';

function fixture() {
  const rows: any[] = [];
  let saves = 0;
  let queue = Promise.resolve();
  const match = (where: any) => rows.find(row => Object.entries(where).every(([k, v]) => row[k] === v)) || null;
  const repo = {
    findOneBy: async (where: any) => match(where),
    findOne: async ({ where }: any) => match(where),
    find: async ({ where, take = rows.length, skip = 0 }: any) => rows.filter(row => Object.entries(where).every(([k, v]) => row[k] === v)).slice(skip, skip + take),
    create: (data: any) => ({ ...data }),
    save: async (data: any) => {
      saves++;
      if (data.id) return data;
      const row = { id: rows.length + 1, ...data };
      rows.push(row); return row;
    },
  };
  const users = { findOne: async ({ where }: any) => ['u1', 'u2'].includes(where.phoneNumber) ? { id: where.phoneNumber } : null };
  const manager = { getRepository: (entity: any) => entity === UserEntity ? users : repo };
  const service = new OrderService();
  service.orderModel = { ...repo, manager: { transaction: async (fn: any) => {
    const prior = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await fn(manager); } finally { release(); }
  } } } as any;
  const controller = (userId = 'u1', role = 'user') => {
    const c = new MaterialsHTTPService();
    c.ctx = { userInfo: userId ? { userId, role } : undefined } as any;
    c.orderService = service;
    c.entitlementService = { check: async () => ({ allowed: false }) } as any;
    c.materialsService = {
      groupedListReady: async () => [{ key: 'agent', items: [{ key: 'agent-basics' }] }],
      isReady: async () => true,
      downloadUrl: async () => 'https://fixture.invalid/private.pdf',
    } as any;
    return c;
  };
  return { service, rows, controller, saves: () => saves };
}

describe('资料人工核实与下载资格兼容', () => {
  for (const status of ['self_reported', 'paid']) {
    for (const verified of [undefined, false, true]) {
      it(status + ' / bankVerified=' + verified + ' 均可下载，重复声明不新增或覆盖', async () => {
        const f = fixture(); await f.service.reportPdfPurchase('u1');
        Object.assign(f.rows[0], { status, bankVerified: verified, amount: 9.9 });
        const before = { ...f.rows[0] };
        const repeat = await f.controller().confirmPurchase({ bankVerified: true, status: 'paid', userId: 'u2' } as any);
        assert.strictEqual(repeat.data.created, false);
        assert.strictEqual(repeat.data.bankVerified, verified === true);
        assert.strictEqual(repeat.data.order.status, status);
        assert.strictEqual((await f.controller().purchaseStatus()).data.canDownload, true);
        assert.strictEqual((await f.controller().download('agent-basics')).data.url, 'https://fixture.invalid/private.pdf');
        assert.deepStrictEqual(f.rows[0], before);
        assert.strictEqual(f.rows.length, 1);
        assert.strictEqual(f.saves(), 1);
      });
    }
  }

  it('用户声明不核实到账、不写 paid，身份和核实字段不能由 body 伪造', async () => {
    const f = fixture();
    const result = await f.controller().confirmPurchase({ userId: 'u2', bankVerified: true, bankVerifiedBy: 'admin', status: 'paid' } as any);
    assert.strictEqual(result.data.bankVerified, false);
    assert.strictEqual(f.rows[0].userId, 'u1');
    assert.strictEqual(f.rows[0].status, 'self_reported');
    assert.strictEqual(f.rows[0].bankVerified, false);
    assert.strictEqual(await f.service.getPdfPurchase('u2'), null);
    await assert.rejects(f.controller('u2').download('agent-basics'));
  });

  it('人工核实幂等，保留原订单状态和下载；取消核实也不取消下载', async () => {
    const f = fixture(); const order = (await f.service.reportPdfPurchase('u1')).order;
    const before = { ...f.rows[0] };
    const [first, repeat] = await Promise.all([
      f.service.setPdfPaymentVerification(order.orderNo, true, 'admin-a'),
      f.service.setPdfPaymentVerification(order.orderNo, true, 'admin-b'),
    ]);
    assert.strictEqual(first.changed, true);
    assert.strictEqual(repeat.changed, false);
    assert.strictEqual(f.rows[0].bankVerifiedBy, 'admin-a');
    assert.ok(f.rows[0].bankVerifiedAt instanceof Date);
    assert.strictEqual(f.rows[0].status, before.status);
    assert.strictEqual(f.rows[0].payTime, before.payTime);
    assert.strictEqual(f.rows[0].amount, before.amount);
    assert.strictEqual(f.rows[0].userId, before.userId);
    assert.strictEqual((await f.controller().confirmPurchase({})).data.bankVerified, true);
    assert.strictEqual(await f.service.getPdfPurchase('u2'), null);
    await f.service.setPdfPaymentVerification(order.orderNo, false, 'admin-a');
    assert.strictEqual(f.rows[0].bankVerified, false);
    assert.strictEqual(f.rows[0].bankVerifiedAt, null);
    assert.strictEqual((await f.controller().purchaseStatus()).data.canDownload, true);
  });

  for (const status of ['refunded', 'cancelled', 'canceled', 'pending', 'failed']) {
    it(status + ' 不可下载、重报或核实复活，已有记录不被修改', async () => {
      const f = fixture(); const order = (await f.service.reportPdfPurchase('u1')).order;
      Object.assign(f.rows[0], { status, bankVerified: true });
      const before = { ...f.rows[0] };
      assert.strictEqual(await f.service.getPdfPurchase('u1'), null);
      await assert.rejects(f.controller().download('agent-basics'));
      await assert.rejects(f.service.reportPdfPurchase('u1'));
      await assert.rejects(f.service.setPdfPaymentVerification(order.orderNo, true, 'admin'));
      assert.deepStrictEqual(f.rows[0], before);
      assert.strictEqual(f.saves(), 1);
    });
  }

  it('只有管理员可列订单及核实，操作者取登录身份，忽略伪造身份/状态', async () => {
    const f = fixture(); const order = (await f.service.reportPdfPurchase('u1')).order;
    for (const c of [f.controller(), f.controller('')]) {
      await assert.rejects(c.adminPurchases({}));
      await assert.rejects(c.adminPaymentVerification({ orderNo: order.orderNo, bankVerified: true }));
    }
    assert.strictEqual(f.rows[0].bankVerified, false);
    const admin = f.controller('real-admin', 'admin');
    await admin.adminPaymentVerification({ orderNo: order.orderNo, bankVerified: true, bankVerifiedBy: 'forged', status: 'paid' } as any);
    assert.strictEqual(f.rows[0].bankVerifiedBy, 'real-admin');
    assert.strictEqual(f.rows[0].status, 'self_reported');
    const ownOrders = (await f.service.getPdfOrders('u1')).data;
    assert.strictEqual(ownOrders[0].bankVerified, true);
    assert.strictEqual(ownOrders[0].bankVerifiedBy, undefined);
    const listed = (await admin.adminPurchases({})).data;
    assert.strictEqual(listed[0].bankVerified, true);
    assert.strictEqual(listed[0].userId, 'u1');
    assert.strictEqual(listed[0].bankVerifiedBy, 'real-admin');
    await assert.rejects(admin.adminPaymentVerification({ orderNo: order.orderNo, bankVerified: 'true' } as any));
    // FaaS 参数装饰器从首参的 query 取值；裸方法直接读取 take。
    await assert.rejects(admin.adminPurchases({ take: 101, query: { take: 101 } } as any));
    await assert.rejects(f.service.setPdfPaymentVerification('missing', true, 'real-admin'));
  });

  it('该商品外的 paid PDF 订单不冒充当前商品资格，会员订单不能被该接口核实', async () => {
    const f = fixture(); await f.service.reportPdfPurchase('u1');
    f.rows[0].orderNo = 'other-product'; f.rows[0].status = 'paid';
    assert.strictEqual(await f.service.getPdfPurchase('u1'), null);
    f.rows[0].type = 'member';
    await assert.rejects(f.service.setPdfPaymentVerification('other-product', true, 'admin'));
    assert.strictEqual(f.rows[0].bankVerified, false);
  });
});
