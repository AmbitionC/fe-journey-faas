/**
 * 内容模块配置
 *
 * 模块名(module) 与仓库/OSS 目录名的映射，以及扁平模块标记。
 *
 * - interview / knowledge: 目录名 == 模块名，路径为 {module}/{filePath}/{key}.md
 * - firstclass: 目录名 = 'class'，扁平布局，路径为 class/{key}.md（无 filePath）
 */

/** 模块 → 仓库/OSS 目录名 */
export const MODULE_DIR: Record<string, string> = {
  interview: 'interview',
  knowledge: 'knowledge',
  firstclass: 'class',
};

/** 扁平模块集合（无 filePath 子目录） */
export const FLAT_MODULES = new Set(['firstclass']);

/** 所有支持的模块 */
export const ALL_MODULES = ['interview', 'knowledge', 'firstclass'];

/** 获取模块对应的仓库/OSS 目录名 */
export function repoDir(m: string): string {
  return MODULE_DIR[m] || m;
}

/** 是否为扁平模块（无 filePath 子目录） */
export function isFlat(m: string): boolean {
  return FLAT_MODULES.has(m);
}

/** manifest 文件路径（相对于仓库根）*/
export function manifestPath(m: string): string {
  return `${repoDir(m)}/_tree.json`;
}

/**
 * 文章文件路径（相对于仓库根 / OSS 对象 key）
 *
 * - 扁平模块(firstclass): `class/{key}.md`
 * - 普通模块(interview/knowledge): `{module}/{filePath}/{key}.md`
 */
export function articlePath(m: string, filePath: string, key: string): string {
  if (isFlat(m)) {
    return `${repoDir(m)}/${key}.md`;
  }
  return `${repoDir(m)}/${filePath}/${key}.md`;
}

/**
 * 反向查找：给定仓库路径，返回对应的模块名；找不到则返回 null
 */
export function moduleOfPath(p: string): string | null {
  for (const m of ALL_MODULES) {
    if (p.startsWith(repoDir(m) + '/')) return m;
  }
  return null;
}
