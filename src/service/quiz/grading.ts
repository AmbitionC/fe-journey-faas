/**
 * 测一测判分与掌握度回流——纯函数（PRD-01 F1-1 / F1-2）。
 * 无 IO、无 DI，便于单测。客观题在此判分；简答(qa)交 AI（见 proxy.gradeSubmission）。
 */

export type QuestionType = 'single' | 'multi' | 'blank' | 'qa';
export type Mastery = 'new' | 'review' | 'mastered';

export interface GradableQuestion {
  id: string | number;
  type: QuestionType;
  /** 选择题为选项 key 数组；填空为每空答案(可用 | 分隔多个可接受答案)；qa 为要点 */
  answer: string[] | null;
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/** 集合相等（忽略顺序/大小写/空白） */
function setEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a.map(norm));
  const sb = new Set(b.map(norm));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * 客观题判分。qa 返回 null（需 AI 判分）。
 * @returns true/false，或 null（无法规则判分）
 */
export function gradeObjective(
  q: GradableQuestion,
  userAnswer: string[] | null | undefined
): boolean | null {
  const ua = Array.isArray(userAnswer) ? userAnswer : [];
  const ans = Array.isArray(q.answer) ? q.answer : [];
  switch (q.type) {
    case 'single':
    case 'multi':
      if (!ans.length) return null;
      return setEqual(ua, ans);
    case 'blank': {
      if (!ans.length) return null;
      if (ua.length !== ans.length) return false;
      // 逐空比对；每空可用 | 列出多个可接受答案
      return ans.every((expected, i) => {
        const accepts = String(expected)
          .split('|')
          .map(norm)
          .filter(Boolean);
        return accepts.includes(norm(ua[i]));
      });
    }
    case 'qa':
    default:
      return null;
  }
}

/** 得分(0-100) → 目标掌握度（PRD-01 F1-2：≥80 mastered，否则 review） */
export function scoreToMastery(score: number): Mastery {
  return score >= 80 ? 'mastered' : 'review';
}

const RANK: Record<Mastery, number> = { new: 0, review: 1, mastered: 2 };

/**
 * 掌握度合并。
 * - mode='atLeast'：只升不降（算法通过/高自评等旁路信号用）。
 * - mode='authoritative'：以新结果为准，可升可降（本人重新测验/自评用）。
 */
export function mergeMastery(
  current: Mastery | undefined | null,
  target: Mastery,
  mode: 'atLeast' | 'authoritative' = 'authoritative'
): Mastery {
  const cur = (current as Mastery) || 'new';
  if (mode === 'atLeast') {
    return RANK[target] >= RANK[cur] ? target : cur;
  }
  return target;
}

/** 由每题对错算总分(0-100，四舍五入)。空题集合返回 0。 */
export function computeScore(results: Array<boolean>): {
  score: number;
  correctCount: number;
  totalCount: number;
} {
  const totalCount = results.length;
  const correctCount = results.filter(Boolean).length;
  const score = totalCount ? Math.round((correctCount / totalCount) * 100) : 0;
  return { score, correctCount, totalCount };
}
