import * as assert from 'assert';
import { createHash } from 'crypto';
import { buildPdfSalesReport, pdfSalesWindow } from '../src/service/growth/pdfSales';

const now = new Date('2026-10-05T12:00:00Z');
const row = (changes: any = {}) => ({
  id: '1', userId: 'buyer-a', type: 'pdf',
  orderNo: `PDF-${createHash('sha256').update(`agent-career-pdf-v1:${changes.userId || 'buyer-a'}`).digest('hex')}`,
  amount: '9.90', payTime: '2026-10-05T01:00:00Z', updateTime: '2026-10-05T01:00:00Z',
  status: 'self_reported', channel: null, bankVerified: false, ...changes,
});
const build = (orders: any[], excludedUserIds: string[] = []) => buildPdfSalesReport({ orders, excludedUserIds, days: 7, now });

describe('现有增长页 PDF 自报销售补充', () => {
  it('快照金额和订单号去重，并同时形成日趋势/订单来源', () => {
    const report = build([row(), row({ id: '2' }), row({ id: '3', userId: 'buyer-b', amount: '19.80', channel: 'xhs-note-a' })]);
    assert.deepStrictEqual(report.summary, { amountCents: 2970, orders: 2, unknownSourceOrders: 1 });
    assert.strictEqual(report.daily[6].amountCents, 2970);
    assert.strictEqual(report.daily[6].orders, 2);
    assert.strictEqual(report.channels.find((c: any) => c.channel === '未知').orders, 1);
    assert.strictEqual(report.quality.duplicateRows, 1);
  });
  it('人工核实或取消核实不会改变自报金额和订单数，不额外加核实子集', () => {
    const before = build([row(), row({ userId: 'buyer-b' })]);
    const after = build([row({ bankVerified: true, bankVerifiedBy: 'private-admin', bankVerifiedAt: now }), row({ userId: 'buyer-b' })]);
    assert.deepStrictEqual(after, before);
    assert.strictEqual(after.basis, 'self_reported');
    assert.ok(!JSON.stringify(after).includes('private-admin'));
    assert.ok(!('bankVerified' in after) && !('netCashflow' in after));
  });
  it('只认当前商品自报，不混入旧paid/其他SKU/书籍、会员或历史700元', () => {
    const otherSku = `PDF-${createHash('sha256').update('future-pdf:buyer-b').digest('hex')}`;
    const report = build([row(), row({ userId: 'buyer-b', orderNo: otherSku }), row({ userId: 'buyer-c', status: 'paid', amount: '700' }), row({ type: 'member' }), row({ orderNo: 'OLD-PAID', amount: 700 })]);
    assert.strictEqual(report.summary.amountCents, 990);
    assert.strictEqual(report.summary.orders, 1);
  });
  it('退款/取消状态优先排除重复副本，内部账号与无效快照排除', () => {
    const report = build([row(), row({ id: '2', status: 'refunded', updateTime: '2026-10-05T02:00:00Z' }),
      row({ userId: 'buyer-b', status: 'cancelled' }), row({ userId: 'buyer-c', status: 'canceled' }),
      row({ userId: 'internal' }), row({ userId: 'invalid', amount: 'bad' })], ['internal']);
    assert.strictEqual(report.summary.orders, 0);
    assert.strictEqual(report.excludedStatuses.refunded, 1);
    assert.strictEqual(report.excludedStatuses.cancelled, 2);
    assert.strictEqual(report.quality.internalRows, 1);
    assert.strictEqual(report.quality.invalidRows, 1);
  });
  it('重复金额选首次声明快照，核实导致更新时间变化不会改金额或复活退款', () => {
    const first = row({ id: '1', amount: '9.90' });
    const duplicate = row({ id: '2', amount: '19.80' });
    const before = build([duplicate, first]);
    const verified = { ...duplicate, bankVerified: true, updateTime: '2026-10-05T09:00:00Z' };
    assert.deepStrictEqual(build([first, verified]), before);
    assert.strictEqual(before.summary.amountCents, 990);
    const refunded = { ...first, status: 'refunded', updateTime: '2026-10-05T02:00:00Z' };
    assert.strictEqual(build([refunded, verified]).summary.amountCents, 0);
    assert.strictEqual(build([verified, refunded]).excludedStatuses.refunded, 1);
    assert.strictEqual(build([first, { ...duplicate, status: 'paid' }]).summary.orders, 0);
  });
  it('先去重所有副本再按首次声明日期归组，跨窗口重复不算新增', () => {
    const original = row({ id: '1', payTime: '2026-09-20T01:00:00Z' });
    const inWindow = row({ id: '2' });
    assert.strictEqual(build([inWindow, original]).summary.orders, 0);
    const originalInWindow = row({ id: '1' });
    const outsideRefund = row({ id: '2', status: 'refunded', payTime: '2026-09-20T01:00:00Z' });
    assert.strictEqual(build([originalInWindow, outsideRefund]).summary.orders, 0);
    assert.strictEqual(build([outsideRefund, originalInWindow]).excludedStatuses.refunded, 1);
    assert.strictEqual(build([originalInWindow, { ...outsideRefund, payTime: null }]).summary.orders, 0);
    assert.strictEqual(build([originalInWindow, { ...outsideRefund, payTime: null }]).excludedStatuses.refunded, 1);
  });
  it('渠道缺失或含个人标识归未知，输出不含账号/订单号/核实人等原始数据', () => {
    const report = build([row({ userId: 'private-user', amount: '0.10', channel: 'person@example.test' }),
      row({ userId: 'buyer-b', amount: '0.20', channel: '13800000000' }),
      row({ userId: 'buyer-c', amount: '0.30', channel: 'contact-138-0000-0000' })]);
    assert.strictEqual(report.summary.amountCents, 60);
    assert.strictEqual(report.summary.unknownSourceOrders, 3);
    const json = JSON.stringify(report);
    assert.ok(!/private-user|buyer-b|PDF-|person@|13800000000|138-0000-0000/.test(json));
  });
  it('北京时间自然日窗口有上限且排除未来记录，不把查询成功的空订单当未采集', () => {
    assert.strictEqual(pdfSalesWindow(7, now).start.toISOString(), '2026-09-28T16:00:00.000Z');
    assert.strictEqual(pdfSalesWindow(100000, now).days, 30);
    const report = build([row({ payTime: '2026-10-04T16:00:00Z' }), row({ userId: 'future', payTime: '2026-10-06T00:00:00Z' })]);
    assert.strictEqual(report.daily[6].date, '2026-10-05');
    assert.strictEqual(report.summary.orders, 1);
    assert.deepStrictEqual(build([]).summary, { amountCents: 0, orders: 0, unknownSourceOrders: 0 });
    assert.strictEqual(build([]).quality.exclusionConfigured, false);
  });
});
