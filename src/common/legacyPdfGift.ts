import { createHash } from 'crypto';

/** 用户确认附赠的唯一原文件；不包括 ZIP 内的第三方书籍。 */
export const LEGACY_PDF_KEY = 'legacy-frontend-2024';
export const LEGACY_PDF_SIZE = 21409157;
export const LEGACY_PDF_SHA256 = '17194c77def85e5a6cd1a5cb8dde6b9d38422db5ab03ddc611fc2d9e8c5e97b0';
export const LEGACY_PDF_METADATA_KEY = `materials/knowledge/${LEGACY_PDF_KEY}.json`;

export const LEGACY_PDF_GIFT = Object.freeze({
  key: LEGACY_PDF_KEY,
  label: '附赠：前端知识点汇总（2024 年历史版，仅供参考）',
  pageCount: 365,
  edition: '2024',
  priceCents: 0,
  referenceOnly: true,
  guidance: '旧版内容未全面更新。学习与面试请优先参考当前知识库和官方文档；页码为这份合并 PDF 的页码。',
  errata: [
    { page: 185, text: 'getSnapshotBeforeUpdate 在 render 之后、DOM 更新之前调用。', source: 'https://react.dev/reference/react/Component#getsnapshotbeforeupdate' },
    { page: 186, text: 'componentDidCatch 是实例方法；getDerivedStateFromError 才是静态方法。', source: 'https://react.dev/reference/react/Component#componentdidcatch' },
    { page: 187, text: 'useEffect 的依赖变化后，先执行旧的清理，再执行新的副作用；依赖不变时跳过该次执行。', source: 'https://react.dev/reference/react/useEffect' },
  ],
});

export function assertLegacyPdf(buf: Buffer): void {
  if (buf.length !== LEGACY_PDF_SIZE || createHash('sha256').update(buf).digest('hex') !== LEGACY_PDF_SHA256) {
    throw new Error('附赠文件与已确认的 2024 年原版 PDF 不一致，请上传指定的「前端知识点汇总.pdf」');
  }
}
