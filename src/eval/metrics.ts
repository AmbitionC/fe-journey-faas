/**
 * AI 评测指标——纯函数（PRD-02 F2-3）。
 * 度量：引用命中率、剧透率、点评/判分正确性、工具调用成功率。
 * 与具体模型调用解耦，便于离线评测与单测。
 */

/** 回答是否给出了站内引用（「延伸阅读」/「参考」/编号引用）。 */
export function hasCitation(text: string): boolean {
  if (!text) return false;
  return /延伸阅读|参考资料|参考[:：]|出处|\[\d+\]/.test(text);
}

/** 引用是否命中相关文章（引用 key 与相关 key 有交集）。 */
export function citationHit(citedKeys: string[], relevantKeys: string[]): boolean {
  if (!citedKeys?.length || !relevantKeys?.length) return false;
  const rel = new Set(relevantKeys);
  return citedKeys.some((k) => rel.has(k));
}

/** 提示是否剧透（包含了应当隐藏的答案关键词）。 */
export function isHintSpoiler(hint: string, answerKeywords: string[]): boolean {
  if (!hint || !answerKeywords?.length) return false;
  const text = hint.toLowerCase();
  return answerKeywords.some((kw) => kw && text.includes(kw.toLowerCase()));
}

/** 判分档位是否与标注一致。 */
export function verdictMatch(actual: string, expected: string): boolean {
  return String(actual || '').trim() === String(expected || '').trim();
}

export interface MetricSummary {
  total: number;
  pass: number;
  rate: number; // 0-1，保留两位
}

/** 把一组布尔结果聚合为通过率。 */
export function aggregate(flags: boolean[]): MetricSummary {
  const total = flags.length;
  const pass = flags.filter(Boolean).length;
  return { total, pass, rate: total ? Math.round((pass / total) * 100) / 100 : 0 };
}
