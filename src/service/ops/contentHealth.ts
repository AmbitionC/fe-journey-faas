/**
 * 内容体检——纯启发式（PRD-08 P1 F1-2）。
 * 对单篇文章正文做静态检查，产出问题清单与健康分。
 * 「死链」的真实连通性校验在 service 层异步做（此处仅抽取链接与可疑模式）。
 */

export type IssueType =
  | 'short' // 内容过短
  | 'stale' // 过时（陈旧年份/旧版本）
  | 'todo' // 遗留 TODO/FIXME/待补充
  | 'link' // 外链需校验
  | 'image' // 图片缺失/空 src
  | 'codeblock'; // 含代码块（建议跑通校验）

export type Severity = 'low' | 'mid' | 'high';

export interface HealthIssue {
  type: IssueType;
  severity: Severity;
  detail: string;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { low: 5, mid: 12, high: 25 };

/** 抽取 markdown 中的外链 URL。 */
export function extractLinks(content: string): string[] {
  const links = new Set<string>();
  const reMd = /\]\((https?:\/\/[^)\s]+)\)/g;
  const reBare = /(?<![("])\bhttps?:\/\/[^\s)>"']+/g;
  let m: RegExpExecArray | null;
  while ((m = reMd.exec(content))) links.add(m[1]);
  while ((m = reBare.exec(content))) links.add(m[0]);
  return [...links];
}

export function checkContent(content: string, now = new Date()): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const text = content || '';

  // 过短
  if (text.trim().length < 200) {
    issues.push({ type: 'short', severity: 'high', detail: `正文仅 ${text.trim().length} 字，疑似残缺` });
  }

  // 过时：出现 3 年前及更早的年份，或旧版本号迹象
  const curYear = now.getFullYear();
  const years = (text.match(/\b(20\d{2})\b/g) || []).map(Number);
  const oldYears = years.filter((y) => y <= curYear - 3);
  if (oldYears.length) {
    issues.push({
      type: 'stale',
      severity: 'mid',
      detail: `提到较旧年份 ${[...new Set(oldYears)].join('、')}，请核对是否过时`,
    });
  }

  // 遗留标记
  if (/TODO|FIXME|待补充|待完善|占位/i.test(text)) {
    issues.push({ type: 'todo', severity: 'mid', detail: '存在 TODO/待补充等遗留标记' });
  }

  // 空图片
  const emptyImg = text.match(/!\[[^\]]*\]\(\s*\)/g);
  if (emptyImg) {
    issues.push({ type: 'image', severity: 'high', detail: `${emptyImg.length} 处图片 src 为空` });
  }

  // 外链
  const links = extractLinks(text);
  if (links.length) {
    issues.push({ type: 'link', severity: 'low', detail: `含 ${links.length} 个外链，建议校验可达性` });
  }

  // 代码块
  const codeBlocks = (text.match(/```[a-zA-Z]*\n/g) || []).length;
  if (codeBlocks) {
    issues.push({ type: 'codeblock', severity: 'low', detail: `含 ${codeBlocks} 个代码块，建议跑通校验` });
  }

  return issues;
}

/** 健康分（0-100，越高越健康）。 */
export function healthScore(issues: HealthIssue[]): number {
  const penalty = issues.reduce((acc, i) => acc + SEVERITY_WEIGHT[i.severity], 0);
  return Math.max(0, 100 - penalty);
}
