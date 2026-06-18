import { R } from '../../common/base.error.utils';

/**
 * filePath 允许 `/` 分隔多级目录，但每一段不得为 `..`，不得以 `/` 开头/结尾，
 * 只允许 [\w./-]（字母数字下划线、点、斜杠、横杠）。
 * **filePath 允许为空字符串**——扁平模块(firstclass) filePath 为空。
 * key 不得含 `/` 或 `..`，只允许 [\w.-]。
 * 违反时抛 R.error('非法路径')。
 */
export function assertSafeSegment(filePath: string, key: string): void {
  // --- key 校验 ---
  if (!/^[\w.-]+$/.test(key) || key === '..' || key.includes('/')) {
    throw R.error('非法路径');
  }

  // --- filePath 校验（空字符串合法，扁平模块使用）---
  if (filePath === '') return;

  // 不允许以 / 开头或结尾
  if (/^\//.test(filePath) || /\/$/.test(filePath)) {
    throw R.error('非法路径');
  }
  // 只允许 [\w./-]
  if (!/^[\w./-]+$/.test(filePath)) {
    throw R.error('非法路径');
  }
  // 每一段不得为 ..
  if (filePath.split('/').includes('..')) {
    throw R.error('非法路径');
  }
}

/**
 * 规范化 filePath：去除首尾斜杠，与 buildObjectKey 保持一致。
 */
export function normalizeFilePath(filePath: string): string {
  return String(filePath || '').replace(/^\/+|\/+$/g, '');
}
