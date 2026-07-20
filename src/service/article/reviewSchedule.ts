/**
 * 复习到期判定——纯函数（PRD-01 F1-3）。
 * 用可配置的「按掌握度固定间隔」规则替换写死的 14 天逻辑：
 *   未掌握(new/无) → 当天到期；review → 3 天；mastered → 14 天。
 * 后续可平滑替换为间隔重复(SM-2/FSRS, 见 PRD-01 F2-1)。
 */

export interface ReviewRow {
  articleKey: string;
  status: string;
  mastery?: string;
  lastReadAt: number;
  lastScore?: number; // 最近一次测验得分(可选)
}

export interface ReviewRule {
  intervalDays: Record<string, number>; // 按掌握度的间隔天数
}

export const DEFAULT_REVIEW_RULE: ReviewRule = {
  intervalDays: { new: 0, review: 3, mastered: 14 },
};

export interface ReviewDueItem {
  articleKey: string;
  reason: string; // 到期原因
  mastery: string;
  lastScore?: number;
  priority: number; // 优先级(越大越靠前)
  dueAt: number; // 到期时间戳 ms
}

const DAY = 86400000;

/**
 * 计算待复习清单明细。仅 status==='done' 的文章参与复习调度。
 */
export function computeReviewDue(
  reading: ReviewRow[],
  now: number,
  rule: ReviewRule = DEFAULT_REVIEW_RULE
): ReviewDueItem[] {
  const items: ReviewDueItem[] = [];
  for (const r of reading) {
    if (r.status !== 'done') continue;
    const mastery = r.mastery || 'new';
    const intervalDays = rule.intervalDays[mastery] ?? 3;
    const dueAt = Number(r.lastReadAt) + intervalDays * DAY;
    if (now < dueAt) continue; // 未到期

    const overdueDays = Math.floor((now - dueAt) / DAY);
    // 优先级：未掌握 > 待复习 > 已掌握，再叠加逾期天数与低分
    let priority = mastery === 'new' ? 30 : mastery === 'review' ? 20 : 10;
    priority += Math.min(overdueDays, 30);
    if (typeof r.lastScore === 'number' && r.lastScore < 60) priority += 15;

    const reason =
      typeof r.lastScore === 'number'
        ? `上次得分 ${r.lastScore}%`
        : mastery === 'mastered'
        ? '已掌握内容定期巩固'
        : mastery === 'review'
        ? '自评待复习'
        : '学完到间隔，巩固一遍';

    items.push({
      articleKey: r.articleKey,
      reason,
      mastery,
      lastScore: r.lastScore,
      priority,
      dueAt,
    });
  }
  items.sort((a, b) => b.priority - a.priority || a.dueAt - b.dueAt);
  return items;
}
