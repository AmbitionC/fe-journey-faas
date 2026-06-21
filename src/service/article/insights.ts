/**
 * 画像增强——纯函数（PRD-01 F2-2 弱点诊断 / F2-3 兴趣与连续天数）。
 */

const DAY = 86400000;

/** 连续学习天数：按 lastReadAt 的去重自然日，从今天/昨天往前数连续段。 */
export function deriveStreak(timestamps: number[], now: number): number {
  const days = new Set<number>();
  for (const t of timestamps) {
    if (t > 0) days.add(Math.floor(t / DAY));
  }
  if (!days.size) return 0;
  const today = Math.floor(now / DAY);
  let cursor: number;
  if (days.has(today)) cursor = today;
  else if (days.has(today - 1)) cursor = today - 1;
  else return 0;
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor -= 1;
  }
  return streak;
}

export interface WeakTag {
  tag: string;
  score: number; // 薄弱程度(证据权重之和)
  evidenceCount: number;
}

/** 聚合薄弱点：输入若干 {tag, weight} 证据（错题/低自评/算法失败），按标签汇总取 Top-N。 */
export function aggregateWeak(
  evidence: { tag: string; weight: number }[],
  topN = 5
): WeakTag[] {
  const map = new Map<string, { score: number; count: number }>();
  for (const e of evidence) {
    if (!e.tag) continue;
    const cur = map.get(e.tag) || { score: 0, count: 0 };
    cur.score += e.weight;
    cur.count += 1;
    map.set(e.tag, cur);
  }
  return [...map.entries()]
    .map(([tag, v]) => ({ tag, score: Math.round(v.score * 100) / 100, evidenceCount: v.count }))
    .filter((w) => w.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/** 兴趣：按标签出现频次取 Top-N（来源：收藏/已读文章标签）。 */
export function topTags(tags: string[], topN = 6): string[] {
  const map = new Map<string, number>();
  for (const t of tags) {
    if (!t) continue;
    map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([t]) => t);
}
