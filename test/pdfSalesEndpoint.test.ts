import * as assert from 'assert';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { OrderEntity } from '../src/entity/order';
import { GrowthService } from '../src/service/growth';
import { GrowthHTTPService } from '../src/function/growth';

async function fixture(rows: any[] = [], failed = false) {
  const source = new DataSource({ type: 'mysql', database: 'fixture_only', entities: [OrderEntity] });
  await (source as any).buildMetadatas(); // 不initialize，不连接DB。
  let sql = ''; let parameters: any[] = [];
  const service = new GrowthService();
  service.internalUserIds = ['internal-fixture'];
  service.orderModel = { createQueryBuilder: (alias: string) => {
    const qb = source.getRepository(OrderEntity).createQueryBuilder(alias);
    qb.getMany = async () => { [sql, parameters] = qb.getQueryAndParameters(); if (failed) throw new Error('read failed'); return rows; };
    return qb;
  } } as any;
  return { service, query: () => ({ sql, parameters }) };
}

describe('PDF自报补充接口：管理员及最小只读查询', () => {
  it('匿名、普通用户拒绝，管理员Redis登录身份才能读取', async () => {
    const c = new GrowthHTTPService(); let called = 0;
    c.growthService = { pdfSales: async (days: number) => { called++; return { days, basis: 'self_reported' }; } } as any;
    c.ctx = { query: { days: 7 }, request: { query: { days: 7 } } } as any;
    await assert.rejects(c.pdfSales({ days: 7 }));
    c.ctx.userInfo = { userId: 'user-fixture', role: 'user' };
    await assert.rejects(c.pdfSales({ days: 7 }));
    assert.strictEqual(called, 0);
    c.ctx = { headers: { token: 'fixture' }, query: { days: 7 }, request: { query: { days: 7 } } } as any;
    c.redisService = { get: async () => JSON.stringify({ userId: 'admin-fixture', role: 'admin' }) } as any;
    const r = await c.pdfSales({ days: 7 });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data.days, 7);
    assert.strictEqual(called, 1);
  });
  it('真实ORM查询限制商品/时间/行数，只读必要列；核实标记不筛主金额', async () => {
    const { service, query } = await fixture([{ id: '1', userId: 'buyer',
      orderNo: `PDF-${createHash('sha256').update('agent-career-pdf-v1:buyer').digest('hex')}`,
      type: 'pdf', status: 'self_reported', amount: '19.90', payTime: new Date(), bankVerified: true }]);
    const report = await service.pdfSales(7);
    const { sql, parameters } = query();
    assert.ok(sql.includes('EXISTS') && sql.includes('`candidate`.`payTime` >=') && sql.includes('`candidate`.`payTime` <='));
    assert.ok(sql.includes('`candidate`.`orderNo` = `o`.`orderNo`'));
    assert.ok(!sql.includes('`o`.`payTime` >='));
    assert.ok(sql.includes('LIMIT 20001'));
    assert.ok(parameters.includes('pdf') && parameters.includes('PDF-%'));
    assert.ok(!sql.includes('bankVerified') && !sql.includes('updateTime') && !sql.includes('INSERT') && !sql.includes('UPDATE'));
    assert.strictEqual(report.summary.amountCents, 1990);
    assert.strictEqual(report.summary.orders, 1);
    assert.ok(!JSON.stringify(report).includes('buyer'));
  });
  it('关联读取的窗口外首次声明与退款副本参与去重，不改成本期新增', async () => {
    const orderNo = `PDF-${createHash('sha256').update('agent-career-pdf-v1:buyer').digest('hex')}`;
    const original = { id: '1', userId: 'buyer', orderNo, type: 'pdf', status: 'self_reported', amount: '9.90', payTime: new Date(Date.now() - 12 * 86400000) };
    const duplicate = { ...original, id: '2', payTime: new Date() };
    assert.strictEqual((await (await fixture([original, duplicate])).service.pdfSales(7)).summary.orders, 0);
    const report = await (await fixture([{ ...original, id: '2', status: 'refunded', payTime: null }, { ...duplicate, id: '1' }])).service.pdfSales(7);
    assert.strictEqual(report.summary.orders, 0);
    assert.strictEqual(report.excludedStatuses.refunded, 1);
  });
  it('读取失败与截断风险显式失败，不能返回0或部分金额', async () => {
    await assert.rejects((await fixture([], true)).service.pdfSales(7), /read failed/);
    await assert.rejects((await fixture(Array.from({ length: 20001 }, () => ({})))).service.pdfSales(90), /记录过多/);
  });
});
