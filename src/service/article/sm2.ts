/**
 * 间隔重复算法 SM-2 简化版——纯函数（PRD-01 F2-1）。
 * 维护每个 (user, article) 的 ease/interval/reps，按作答质量算下次到期 dueAt。
 * 为后续替换为 FSRS 预留同形接口（输入上次状态 + 质量，输出新状态 + dueAt）。
 */

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

export interface SrsState {
  ease: number; // 难度系数(>=1.3)
  interval: number; // 间隔天数
  reps: number; // 连续答对次数
}

export interface SrsNext extends SrsState {
  dueAt: number; // 下次到期(ms)
}

const DAY = 86400000;
const MIN_EASE = 1.3;

/** 质量分 q(0-5)：SM-2 中 <3 视为失败需重来 */
const GRADE_Q: Record<ReviewGrade, number> = { again: 2, hard: 3, good: 4, easy: 5 };

export const DEFAULT_SRS: SrsState = { ease: 2.5, interval: 0, reps: 0 };

/** 测验得分(0-100) → 复习质量档 */
export function scoreToGrade(score: number): ReviewGrade {
  if (score < 40) return 'again';
  if (score < 60) return 'hard';
  if (score < 85) return 'good';
  return 'easy';
}

export function sm2(prev: SrsState, grade: ReviewGrade, now: number): SrsNext {
  const q = GRADE_Q[grade];
  const prior = prev || DEFAULT_SRS;

  // ease 更新（SM-2 公式），下限 1.3
  let ease = prior.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ease < MIN_EASE) ease = MIN_EASE;
  ease = Math.round(ease * 100) / 100;

  let reps: number;
  let interval: number;

  if (q < 3) {
    // 失败：重来，当天再复习
    reps = 0;
    interval = 0;
  } else {
    reps = prior.reps + 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(prior.interval * ease);
    // hard 档稍微压缩间隔
    if (grade === 'hard') interval = Math.max(1, Math.round(interval * 0.8));
  }

  return { ease, interval, reps, dueAt: now + interval * DAY };
}
