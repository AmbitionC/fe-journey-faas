import { createHash } from 'crypto';

/**
 * 知识点 PDF 的售卖形态（owner 2026-10-31 定，2026-11-01 起生效）：
 * ¥9.9 单卖下架，PDF 并入唯一的「会员」档（Skill 会员，¥29/月、¥239/年，定价与收费阶段
 * 只在 mcp/billing.ts 一处定义，这里不写价格）。
 *
 * 下载资格四条路，按序判定（function/materials.ts）：
 *   会员权益（含网站存量会员与 Skill 会员）→ 已付 ¥9.9 的老买家 → 公测期（至 11-30）已登录 → 拒绝。
 */

/** 已下架的 ¥9.9 单卖商品。只用于识别历史订单：订单号由 sku+userId 派生，改了就对不上老订单。 */
export const LEGACY_PDF_PRODUCT = Object.freeze({
  sku: 'agent-career-pdf-v1',
  name: 'Agent 求职资料（PDF）',
  priceCents: 990,
  closedAt: '2026-11-01',
});

/** 老 ¥9.9 订单的确定性订单号（每账号一笔）。 */
export function legacyPdfOrderNo(userId: string): string {
  return `PDF-${createHash('sha256').update(`${LEGACY_PDF_PRODUCT.sku}:${userId}`).digest('hex')}`;
}

/**
 * 公测期（至 2026-11-30）登录即可领 PDF，把 PDF 当 12 月 1 日转会员的钩子（owner 2026-10-31 定）。
 * 2026-11-01 起 Skill 调用不再免费（送体验点、用完充值），但 PDF 公测期领取按原定日期保留，
 * 所以这里按日期判断，不再跟 billing 的收费阶段走。owner 若决定提前关闭，置 false 即可。
 */
export const PDF_FREE_PHASE_CLAIM = true;

/** PDF 公测免费领取截止（北京时间这一天零点起关闭） */
export const PDF_FREE_CLAIM_UNTIL = '2026-12-01';

export function pdfFreeClaimActive(now = new Date()): boolean {
  return PDF_FREE_PHASE_CLAIM && now.getTime() < Date.parse(`${PDF_FREE_CLAIM_UNTIL}T00:00:00+08:00`);
}

/** 下载资格依据：会员权益 / 老 ¥9.9 买家 / 公测免费期登录用户 */
export type PdfAccessBasis = 'member' | 'legacy_purchase' | 'free_phase';

export const PDF_MEMBER_BENEFIT = Object.freeze({
  sku: 'member_pdf',
  name: '知识点 PDF（会员权益）',
  purchaseType: 'membership',
  scope: '按知识库目录整理的全套知识点 PDF，随知识点更新；开通会员即可下载全部，附赠 2024 年前端知识点汇总。',
  /** ¥9.9 单卖已下架；老买家下载资格永久保留 */
  saleClosed: true,
  legacy: LEGACY_PDF_PRODUCT,
  /** 开通会员的页面（Agent Journey 会员页；Skill 接入在 /developer） */
  memberUrl: '/membership',
});
