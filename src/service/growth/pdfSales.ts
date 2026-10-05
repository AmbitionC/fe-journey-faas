import { createHash } from 'crypto';
import { AGENT_PDF_PRODUCT } from '../../common/commerce';

const DAY = 86400000;
const CST = 8 * 3600000;
type Instant = Date | string;
interface PdfSalesOrder {
  id?: string;
  userId: string;
  orderNo: string;
  type: string;
  amount: number | string;
  payTime: Instant | null;
  status: string;
  channel?: string | null;
}
const time = (value?: Instant | null) => value ? new Date(value).getTime() : NaN;
const date = (value: number) => new Date(value + CST).toISOString().slice(0, 10);

export function pdfSalesWindow(requestedDays: number, now = new Date()) {
  const days = [7, 30, 90].includes(Number(requestedDays)) ? Number(requestedDays) : 30;
  const today = Math.floor((now.getTime() + CST) / DAY) * DAY - CST;
  return { days, start: new Date(today - (days - 1) * DAY), end: now };
}

function snapshotCents(value: number | string): number | null {
  const text = String(value ?? '');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
function source(value?: string | null) {
  return value && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
    && value.replace(/\D/g, '').length < 7 ? value : '未知';
}

/** 订单金额/声明时间创建后不变；人工核实会更新 updateTime，因此不能用它挑金额快照。 */
function declarationRank(a: PdfSalesOrder, b: PdfSalesOrder): number {
  const aId = Number(a.id); const bId = Number(b.id);
  if (Number.isSafeInteger(aId) && aId > 0 && Number.isSafeInteger(bId) && bId > 0 && aId !== bId) return aId - bId;
  const aTime = time(a.payTime); const bTime = time(b.payTime);
  return (Number.isFinite(aTime) ? aTime : Infinity) - (Number.isFinite(bTime) ? bTime : Infinity)
    || String(a.amount).localeCompare(String(b.amount)) || String(a.channel || '').localeCompare(String(b.channel || ''));
}

/** 当前商品的自报子集；核实标记不参与金额、资格或去重判断。 */
export function buildPdfSalesReport(input: { orders: PdfSalesOrder[]; days: number; now?: Date; excludedUserIds?: string[] }) {
  const window = pdfSalesWindow(input.days, input.now);
  const start = window.start.getTime();
  const end = window.end.getTime();
  const excluded = new Set((input.excludedUserIds || []).map(id => String(id).trim()).filter(Boolean));
  const quality = { duplicateRows: 0, invalidRows: 0, internalRows: 0, exclusionConfigured: excluded.size > 0 };
  const unique = new Map<string, { snapshot: PdfSalesOrder; statuses: Set<string> }>();
  for (const row of input.orders) {
    if (row.type !== 'pdf' || !row.userId) continue;
    const canonical = `PDF-${createHash('sha256').update(`${AGENT_PDF_PRODUCT.sku}:${row.userId}`).digest('hex')}`;
    if (row.orderNo !== canonical) continue;
    if (!Number.isFinite(time(row.payTime))) quality.invalidRows++;
    if (excluded.has(row.userId)) { quality.internalRows++; continue; }
    const prior = unique.get(row.orderNo);
    if (prior) {
      quality.duplicateRows++;
      prior.statuses.add(row.status);
      if (declarationRank(row, prior.snapshot) < 0) prior.snapshot = row;
    } else {
      unique.set(row.orderNo, { snapshot: row, statuses: new Set([row.status]) });
    }
  }
  const daily = Array.from({ length: window.days }, (_, i) => ({ date: date(start + i * DAY), orders: 0, amountCents: 0 }));
  const byDay = new Map(daily.map(day => [day.date, day]));
  const channels = new Map<string, { channel: string; orders: number; amountCents: number }>();
  const summary = { amountCents: 0, orders: 0, unknownSourceOrders: 0 };
  const excludedStatuses = { refunded: 0, cancelled: 0, other: 0 };
  for (const { snapshot: row, statuses } of unique.values()) {
    // 先合并所有副本，再按首次声明日期归组；跨窗口重复不能成为新销售。
    if (!Number.isFinite(time(row.payTime)) || time(row.payTime) < start || time(row.payTime) > end) continue;
    // 既有购买入口不允许复活退款/取消；重复副本不得使失效订单恢复销售额。
    if (statuses.size !== 1 || !statuses.has('self_reported')) {
      if (statuses.has('refunded')) excludedStatuses.refunded++;
      else if (statuses.has('cancelled') || statuses.has('canceled')) excludedStatuses.cancelled++;
      else excludedStatuses.other++;
      continue;
    }
    const amount = snapshotCents(row.amount);
    if (amount == null) { quality.invalidRows++; continue; }
    summary.orders++; summary.amountCents += amount;
    const day = byDay.get(date(time(row.payTime)))!;
    day.orders++; day.amountCents += amount;
    const channel = source(row.channel);
    if (channel === '未知') summary.unknownSourceOrders++;
    const group = channels.get(channel) || { channel, orders: 0, amountCents: 0 };
    group.orders++; group.amountCents += amount;
    channels.set(channel, group);
  }
  return {
    days: window.days, from: date(start), to: date(end), generatedAt: window.end.toISOString(),
    timezone: 'Asia/Shanghai', basis: 'self_reported', sku: AGENT_PDF_PRODUCT.sku,
    summary, daily, channels: [...channels.values()].sort((a, b) => b.amountCents - a.amountCents), quality, excludedStatuses,
  };
}
