import {
  computeReviewDue,
  ReviewDueItem,
  ReviewRule,
  DEFAULT_REVIEW_RULE,
} from './reviewSchedule';

export interface ReadingRow {
  articleKey: string;
  status: string;
  mastery?: string;
  lastReadAt: number;
  lastScore?: number;
}
export interface ProfileInput {
  reading: ReadingRow[];
  totalArticles: number; // 该模块可学文章总数(由调用方传入)
  now: number;
  rule?: ReviewRule;
}
export interface WeakTagVO {
  tag: string;
  score: number;
  evidenceCount: number;
}

export interface Profile {
  coverage: { done: number; total: number; ratio: number };
  recentKeys: string[];
  reviewDue: string[]; // 到期待复习的文章 key（按优先级排序）
  reviewDueDetail: ReviewDueItem[]; // 到期明细：原因/上次得分/优先级（PRD-01 F1-3）
  interests: string[]; // 兴趣标签（PRD-01 F2-3）
  streak: number; // 连续学习天数（PRD-01 F2-3）
  weakTags: WeakTagVO[]; // 弱点诊断 Top-N（PRD-01 F2-2）
}

export function buildProfile(input: ProfileInput): Profile {
  const { reading, totalArticles, now } = input;
  const done = reading.filter((r) => r.status === 'done').length;
  const recentKeys = [...reading]
    .sort((a, b) => b.lastReadAt - a.lastReadAt)
    .slice(0, 8)
    .map((r) => r.articleKey);

  // 用可配置的「按掌握度固定间隔」规则替换写死的 14 天逻辑（PRD-01 F1-3）
  const reviewDueDetail = computeReviewDue(
    reading,
    now,
    input.rule || DEFAULT_REVIEW_RULE
  );

  return {
    coverage: { done, total: totalArticles, ratio: totalArticles ? done / totalArticles : 0 },
    recentKeys,
    reviewDue: reviewDueDetail.map((d) => d.articleKey),
    reviewDueDetail,
    interests: [],
    streak: 0,
    weakTags: [],
  };
}
