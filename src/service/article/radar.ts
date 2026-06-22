/**
 * 能力雷达——纯函数（PRD-01 F3-2）。
 * 按大类（导航一级分类）把学习状态聚合为 0-100 的能力分。
 */

export interface RadarInput {
  category: string;
  total: number; // 该类文章总数
  states: { status?: string; mastery?: string }[]; // 该类下已有学习记录的文章
}

export interface RadarDim {
  name: string;
  score: number; // 0-100
  done: number; // 已完成篇数
  total: number;
}

/** 单篇学习权重：掌握>复习>已读>在读 */
function weight(s: { status?: string; mastery?: string }): number {
  if (s.mastery === 'mastered') return 1;
  if (s.mastery === 'review') return 0.6;
  if (s.status === 'done') return 0.4;
  if (s.status === 'reading') return 0.2;
  return 0;
}

export function computeRadar(inputs: RadarInput[]): RadarDim[] {
  return inputs
    .filter((i) => i.total > 0)
    .map((i) => {
      const sum = i.states.reduce((acc, s) => acc + weight(s), 0);
      const done = i.states.filter((s) => s.status === 'done').length;
      const score = Math.min(100, Math.round((sum / i.total) * 100));
      return { name: i.category, score, done, total: i.total };
    });
}
