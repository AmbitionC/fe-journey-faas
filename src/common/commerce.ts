/** 用户已选定当前 Agent 求职 PDF；支付声明不代表到账核验。 */
export const AGENT_PDF_PRODUCT = Object.freeze({
  sku: 'agent-career-pdf-v1',
  name: 'Agent 求职资料（PDF）',
  priceCents: 990,
  purchaseType: 'one_time',
  scopeStatus: 'confirmed',
  scopeConfirmed: true,
  scope: '当前已生成的 Agent 求职知识点 PDF，具体主题与文件见下方清单。',
  includesMembership: false,
  paymentBasis: 'user_self_reported',
  bankVerified: false,
  message: '使用微信个人收款码转账 ¥9.9 后，点击「我已支付」开放当前清单的下载。本站记录你的支付声明，未核验到账。',
});
