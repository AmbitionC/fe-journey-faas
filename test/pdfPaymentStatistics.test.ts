import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { DataSource } from 'typeorm';
import { OrderEntity } from '../src/entity/order';
import { GrowthService } from '../src/service/growth';
import { GrowthHTTPService } from '../src/function/growth';

const sqlite = `
import sys,json,sqlite3
p=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.row_factory=sqlite3.Row
db.execute('CREATE TABLE "order" (id INTEGER, userId TEXT, type TEXT, amount REAL, payTime TEXT, status TEXT, bankVerified INTEGER)')
keys=['id','userId','type','amount','payTime','status','bankVerified']
db.executemany('INSERT INTO "order" VALUES (?,?,?,?,?,?,?)',[[r.get(k) for k in keys] for r in p['rows']])
print(json.dumps([dict(r) for r in db.execute(p['sql'],p['params'])]))
`;

// 真实 TypeORM 查询生成 SQL，在标准库 SQLite 内存库执行；不连接 MySQL/Redis/生产数据。
function sqlRepo(source: DataSource, rows: any[]) {
  return { createQueryBuilder: (alias: string) => {
    const qb = source.createQueryBuilder(OrderEntity, alias);
    const run = () => {
      const [sql, params] = qb.getQueryAndParameters();
      const result = spawnSync('/usr/bin/python3', ['-c', sqlite], {
        input: JSON.stringify({ sql, params, rows }), encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    qb.getRawMany = async () => run();
    qb.getRawOne = async () => run()[0];
    return qb;
  } };
}
function emptyRepo() {
  const qb: any = {};
  for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) qb[method] = () => qb;
  qb.getRawOne = async () => ({ count: 0, amount: 0 });
  qb.getRawMany = async () => [];
  return { createQueryBuilder: () => qb };
}

describe('资料核实统计 SQL 回归（本地内存数据）', function () {
  this.timeout(6000); // 真实 SQL 多次在标准库子进程执行；无远端 I/O。
  const primary = (overview: any) => {
    const { monthManuallyVerifiedPdf, ...rest } = overview;
    return rest;
  };
  let source: DataSource;
  before(async () => {
    source = new DataSource({ type: 'mysql', database: 'fixture_only', entities: [OrderEntity] });
    await (source as any).buildMetadatas(); // 不调用 initialize，不打开数据库连接
  });

  function fixture() {
    const now = new Date().toISOString();
    const rows = [
      { userId: 'u1', status: 'self_reported', bankVerified: false },
      { userId: 'u2', status: 'self_reported', bankVerified: true },
      { userId: 'u3', status: 'paid', bankVerified: false },
      { userId: 'u4', status: 'paid', bankVerified: true },
      { userId: 'u5', status: 'refunded', bankVerified: true },
      { userId: 'u6', status: 'cancelled', bankVerified: true },
      { userId: 'u7', status: 'pending', bankVerified: true },
      { userId: 'internal', status: 'self_reported', bankVerified: true },
      { userId: 'u8', status: 'self_reported' },
    ].map((row, i) => ({ id: i + 1, type: 'pdf', amount: 9.9, payTime: now, ...row }));
    const records: any[] = [
      ...rows,
      { id: 20, type: 'member', amount: 29, payTime: now, userId: 'member', status: 'paid', bankVerified: false },
      { id: 21, type: 'pdf', amount: 99, payTime: new Date(Date.now() - 45 * 86400000).toISOString(), userId: 'older', status: 'self_reported', bankVerified: true },
    ];
    const service = new GrowthService();
    service.internalUserIds = ['internal'];
    service.orderModel = sqlRepo(source, records) as any;
    service.bookOrderModel = emptyRepo() as any;
    service.eventLogModel = emptyRepo() as any;
    service.growthStatModel = { findOne: async () => null } as any;
    service.userModel = emptyRepo() as any;
    return { service, rows, records };
  }

  it('新增字段默认未核实，不从历史 paid 状态自动迁移为核实', () => {
    const column = source.getMetadata(OrderEntity).findColumnWithPropertyName('bankVerified');
    assert.strictEqual(column.default, false);
    assert.strictEqual(column.isNullable, false);
  });

  it('自报总数保持原口径，人工核实/未核实为额外子集；退款/取消/内部账号不计入', async () => {
    const { service } = fixture();
    const declared = await service.selfReportedOrders(7);
    const verified = await service.manuallyVerifiedPdfOrders(7);
    const unverified = await service.unverifiedSelfReportedPdfOrders(7);
    const legacy = await service.legacyPaidPdfOrders(7);
    assert.strictEqual(declared.window.count, 3);
    assert.ok(Math.abs(declared.window.amount - 29.7) < 1e-9);
    assert.strictEqual(declared.countedAsRevenue, false);
    assert.deepStrictEqual(verified.window, { count: 2, amount: 19.8, buyers: 2 });
    assert.strictEqual(verified.subsetOfPrimary, true);
    assert.strictEqual(verified.verificationMethod, 'manual');
    assert.deepStrictEqual(legacy.window, { count: 1, amount: 9.9, buyers: 1 });
    assert.strictEqual(legacy.manuallyVerified, false);
    assert.deepStrictEqual(unverified.window, { count: 2, amount: 19.8, buyers: 2 });
    assert.strictEqual((await service.manuallyVerifiedPdfOrders(7, ['u2'])).window.count, 1);
  });

  it('主统计计入有效自报及历史 paid，人工核实前后金额/数量/日趋势完全不变', async () => {
    const { service, rows } = fixture();
    const since = new Date(Date.now() - 7 * 86400000);
    const revenue = await (service as any).paidOrders(since);
    assert.deepStrictEqual(revenue.pdf, { count: 5, amount: 49.5 });
    assert.deepStrictEqual(revenue.member, { count: 1, amount: 29 });
    const before = await service.overview();
    const trend = await service.daily(7);
    assert.strictEqual(before.monthRevenue, 78.5);
    assert.strictEqual(before.monthRevenueBasis, 'reported_or_legacy_paid');
    assert.strictEqual(trend.list.reduce((sum: number, row: any) => sum + row.revenue, 0), 78.5);
    rows[0].bankVerified = true;
    assert.strictEqual(rows[0].status, 'self_reported');
    assert.strictEqual((await service.selfReportedOrders(7)).window.count, 3);
    assert.strictEqual((await service.manuallyVerifiedPdfOrders(7)).window.count, 3);
    const after = await (service as any).paidOrders(since);
    assert.deepStrictEqual(after, revenue);
    const updated = await service.overview();
    assert.deepStrictEqual(primary(updated), primary(before));
    assert.strictEqual(updated.monthManuallyVerifiedPdf.count, 3);
    assert.strictEqual(updated.netCashflowBasis, 'reported_sales_minus_recorded_cost');
    assert.deepStrictEqual(await service.daily(7), trend);
  });

  it('审核反例：9.9 自报和19.9历史 paid 均不会因核实消失，也不会被天然核实', async () => {
    const { service, records } = fixture();
    records.splice(0, records.length,
      { id: 1, type: 'pdf', amount: 9.9, payTime: new Date().toISOString(), userId: 'u1', status: 'self_reported', bankVerified: false },
      { id: 2, type: 'pdf', amount: 19.9, payTime: new Date().toISOString(), userId: 'u2', status: 'paid', bankVerified: false });
    const declared = await service.selfReportedOrders(7);
    const before = await service.overview();
    const trend = await service.daily(7);
    assert.strictEqual(declared.window.amount, 9.9);
    assert.ok(Math.abs(before.monthRevenue - 29.8) < 1e-9);
    assert.strictEqual((await service.manuallyVerifiedPdfOrders(7)).window.count, 0);
    for (const row of records) {
      row.bankVerified = true;
      assert.deepStrictEqual(await service.selfReportedOrders(7), declared);
      assert.deepStrictEqual(primary(await service.overview()), primary(before));
      assert.deepStrictEqual(await service.daily(7), trend);
    }
    assert.strictEqual((await service.manuallyVerifiedPdfOrders(7)).window.count, 2);
    records.forEach(row => { row.bankVerified = false; });
    assert.deepStrictEqual(primary(await service.overview()), primary(before));
    assert.deepStrictEqual(await service.daily(7), trend);
  });

  it('已有 overview 提供人工核实 PDF 子集，查询失败显示未知，不伪造为零', async () => {
    const { service } = fixture();
    const before = await service.overview();
    assert.strictEqual(before.monthManuallyVerifiedPdf.verificationMethod, 'manual');
    assert.strictEqual(before.monthManuallyVerifiedPdf.scope, 'pdf');
    service.manuallyVerifiedPdfOrders = async () => ({ month: { count: 0, amount: 0, error: 'query_failed' } }) as any;
    const unavailable = await service.overview();
    assert.strictEqual(unavailable.monthManuallyVerifiedPdf, null);
    assert.deepStrictEqual(primary(unavailable), primary(before));
  });

  it('复盘导出保留 selfReported/topPaths，并暴露核实与待核实历史 PDF 汇总', async () => {
    const c = new GrowthHTTPService();
    c.syncSecret = 'fixture-export-only';
    c.ctx = { headers: { 'x-sync-secret': 'fixture-export-only' } } as any;
    const stub: any = {};
    for (const name of ['overview', 'funnel', 'pathFunnel', 'channels', 'daily', 'signupAudit', 'aiUsage', 'selfReportedOrders', 'manuallyVerifiedPdfOrders', 'unverifiedSelfReportedPdfOrders', 'legacyPaidPdfOrders', 'topPaths']) {
      stub[name] = async () => ({ name });
    }
    c.growthService = stub;
    c.metricsService = { overview: async () => ({}), events: async () => ({}) } as any;
    const data = (await c.exportReview({ days: 7 })).data;
    assert.strictEqual(data.selfReported.name, 'selfReportedOrders');
    assert.strictEqual(data.manuallyVerifiedPdf.name, 'manuallyVerifiedPdfOrders');
    assert.strictEqual(data.unverifiedSelfReportedPdf.name, 'unverifiedSelfReportedPdfOrders');
    assert.strictEqual(data.legacyPaidPdf.name, 'legacyPaidPdfOrders');
    assert.strictEqual(data.topPaths.name, 'topPaths');
  });
});
