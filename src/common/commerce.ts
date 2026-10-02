/** 商品范围尚未获用户选定；仅发布不可购买的准备状态。
 * 不沿用历史公开网盘交付，不将当前会员资料默认并入9.9商品。
 * 真实收款核验和私有交付未接通前禁止开售。
 */
export const PDF_PRODUCT_PREVIEW = Object.freeze({
  sku: 'pdf-one-time-preview',
  name: '学习资料（PDF）',
  priceCents: 990,
  purchaseType: 'one_time',
  scopeStatus: 'pending_confirmation',
  scopeConfirmed: false,
  scope: '资料范围待确认，最终资料范围与交付清单会在开售前公布。',
  includesMembership: false,
  purchasingEnabled: false,
  message: '资料范围与交付方式确认后开放购买，请暂勿转账。',
});
