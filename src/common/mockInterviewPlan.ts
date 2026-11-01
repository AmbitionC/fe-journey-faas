import { ArticleQuestions } from './interviewTopics';

/**
 * 按目标公司 / 岗位模拟面试：从用户选定的那批真实面经里抽一场面试的题。
 * 纯函数，同一个 seed 每次抽出同一场（接口无状态，每轮都按 seed 重算）。
 */

/** 一场面试问几道主题（每道之后面试官可追问一次）。 */
export const PLAN_SIZE = 5;
/** 只在出现最多的前几个考点里抽，保证问的是这家常问的。 */
const TOP_TOPICS = 12;

export interface PlanQuestion {
  topic: string;
  knowledgeKey: string;
  question: string;
  /** 题下第一段答题思路，给面试官判断用，不展示给候选人 */
  answer: string;
  company: string;
  title: string;
  articleKey: string;
}

/** mulberry32：小而稳定的可复现随机数。 */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickInterviewPlan(
  index: ArticleQuestions[],
  opts: {
    keys: string[];
    knowledgeTitles: Map<string, { title: string }>;
    /** 简历、自我介绍、反问这类非技术考点，不进技术题 */
    skipKeys?: Set<string>;
    seed: number;
    size?: number;
  }
): { articlesAnalyzed: number; questions: PlanQuestion[] } {
  const wanted = new Set(opts.keys);
  const scope = index.filter(a => wanted.has(a.articleKey));
  const byTopic = new Map<
    string,
    { articles: Set<string>; candidates: PlanQuestion[] }
  >();
  for (const article of scope) {
    for (const q of article.questions) {
      if (opts.skipKeys?.has(q.key)) continue;
      const t = byTopic.get(q.key) || {
        articles: new Set<string>(),
        candidates: [],
      };
      t.articles.add(article.articleKey);
      t.candidates.push({
        topic: opts.knowledgeTitles.get(q.key)?.title || q.key,
        knowledgeKey: q.key,
        question: q.question,
        answer: q.answer,
        company: article.company,
        title: article.title,
        articleKey: article.articleKey,
      });
      byTopic.set(q.key, t);
    }
  }
  const pool = [...byTopic.entries()]
    .sort(
      (x, y) =>
        y[1].articles.size - x[1].articles.size || x[0].localeCompare(y[0])
    )
    .slice(0, TOP_TOPICS);
  const random = rng(opts.seed);
  const size = Math.min(opts.size || PLAN_SIZE, pool.length);
  const questions: PlanQuestion[] = [];
  // 按出现篇数加权、不放回地抽考点；每个考点里随机挑一道原题
  const remaining = [...pool];
  while (questions.length < size && remaining.length) {
    const total = remaining.reduce((n, [, t]) => n + t.articles.size, 0);
    let r = random() * total;
    let i = 0;
    for (; i < remaining.length - 1; i++) {
      r -= remaining[i][1].articles.size;
      if (r < 0) break;
    }
    const [, t] = remaining.splice(i, 1)[0];
    questions.push(t.candidates[Math.floor(random() * t.candidates.length)]);
  }
  return { articlesAnalyzed: scope.length, questions };
}

/** 只留面试出处（不含题目和要点），给前端在面试结束后展示。 */
export function planSources(questions: PlanQuestion[]) {
  return questions.map(q => ({
    topic: q.topic,
    knowledgeKey: q.knowledgeKey,
    company: q.company,
    title: q.title,
    articleKey: q.articleKey,
  }));
}

/** 前端传来的 seed：取 32 位无符号整数；缺失或非法时用 1（同一批面经仍是确定的一场）。 */
export function normalizeSeed(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) >>> 0 || 1 : 1;
}

/**
 * 题是否已经问完：每道题至多两轮面试官发言（提问 + 一次追问），
 * 面试官已发言 2×题数 轮后，下一轮必须收尾。
 */
export function planExhausted(
  history: { role: string }[],
  planSize: number
): boolean {
  const asked = history.filter(h => h.role === 'interviewer').length;
  return planSize > 0 && asked >= planSize * 2;
}

/** 去掉面试官回复里的结束标记，返回正文与是否结束。 */
export function splitEndMark(
  reply: string,
  mark: string
): { reply: string; finished: boolean } {
  if (!reply.includes(mark)) return { reply, finished: false };
  return { reply: reply.split(mark).join('').trim(), finished: true };
}
