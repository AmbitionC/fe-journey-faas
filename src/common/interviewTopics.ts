import { extractQuestions, navIndex } from '../mcp/tools/agent';

/**
 * 网站「高频考点榜」的统计口径（与 Skill 的 interview_topics 同源：
 * 面经正文里每道题的 data-knowledge-key 就是考点，一个考点出现在几篇面经里就是它的频次，
 * 同一篇只算一次）。这里只放纯函数，取数和会员判定在 function/interviewTopics.ts。
 */

/** 未开通会员能完整看到的前几条（含原题）；其余只给考点名和次数。 */
export const FREE_TOPIC_LIMIT = 3;
/** 每个考点最多返回几道原题（会员）。 */
export const MAX_EXAMPLES = 8;
/** 榜单最多多少条。 */
export const MAX_TOPICS = 50;
/** 一次最多统计多少篇（防止请求体过大）。 */
export const MAX_KEYS = 400;

export interface ArticleQuestions {
  articleKey: string;
  title: string;
  company: string;
  questions: { key: string; question: string }[];
}

export interface TopicExample {
  question: string;
  articleKey: string;
  title: string;
  company: string;
}

export interface TopicRow {
  rank: number;
  topic: string;
  knowledgeKey: string;
  /** 出现在几篇面经里 */
  articles: number;
  /** 问过它的公司（去重，按出现篇数降序） */
  companies: string[];
  /** 原题；未解锁时为空数组 */
  examples: TopicExample[];
  locked: boolean;
}

/** 由面经目录 + 正文建索引：每篇面经 → 公司 + 题目（带考点 key）。 */
export function buildQuestionIndex(
  navData: any[],
  contents: Map<string, string>
): ArticleQuestions[] {
  const nav = navIndex(navData);
  const out: ArticleQuestions[] = [];
  nav.forEach((meta, articleKey) => {
    const content = contents.get(articleKey);
    if (!content) return;
    const questions = extractQuestions(content);
    if (!questions.length) return;
    out.push({
      articleKey,
      title: meta.title,
      // 目录路径第一段是公司（后面是部门）
      company: (meta.path.split(' / ')[0] || '').trim(),
      questions,
    });
  });
  return out;
}

/**
 * 在给定的那批面经里按考点聚合。keys 为空 = 全部。
 * unlocked=false 时只有前 FREE_TOPIC_LIMIT 条带原题，其余 locked。
 */
export function aggregateTopics(
  index: ArticleQuestions[],
  opts: {
    keys?: string[];
    knowledgeTitles: Map<string, { title: string }>;
    unlocked: boolean;
    limit?: number;
  }
): { articlesAnalyzed: number; totalTopics: number; topics: TopicRow[] } {
  const wanted = opts.keys?.length ? new Set(opts.keys) : null;
  const scope = wanted ? index.filter(a => wanted.has(a.articleKey)) : index;
  type Acc = {
    articles: Set<string>;
    companies: Map<string, number>;
    examples: TopicExample[];
  };
  const acc = new Map<string, Acc>();
  for (const article of scope) {
    const seen = new Set<string>();
    for (const q of article.questions) {
      const t = acc.get(q.key) || {
        articles: new Set<string>(),
        companies: new Map<string, number>(),
        examples: [],
      };
      if (!seen.has(q.key)) {
        seen.add(q.key);
        t.articles.add(article.articleKey);
        if (article.company)
          t.companies.set(
            article.company,
            (t.companies.get(article.company) || 0) + 1
          );
      }
      // 同一篇只取一道作候选原题；最终按公司轮流挑，见 pickExamples
      if (!t.examples.some(e => e.articleKey === article.articleKey)) {
        t.examples.push({
          question: q.question,
          articleKey: article.articleKey,
          title: article.title,
          company: article.company,
        });
      }
      acc.set(q.key, t);
    }
  }
  const limit = Math.max(1, Math.min(MAX_TOPICS, opts.limit || MAX_TOPICS));
  const ranked = [...acc.entries()].sort(
    (x, y) =>
      y[1].articles.size - x[1].articles.size ||
      y[1].companies.size - x[1].companies.size ||
      x[0].localeCompare(y[0])
  );
  const topics = ranked.slice(0, limit).map(([key, t], i) => {
    const locked = !opts.unlocked && i >= FREE_TOPIC_LIMIT;
    return {
      rank: i + 1,
      topic: opts.knowledgeTitles.get(key)?.title || key,
      knowledgeKey: key,
      articles: t.articles.size,
      companies: [...t.companies.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([c]) => c),
      examples: locked ? [] : pickExamples(t.examples),
      locked,
    };
  });
  return { articlesAnalyzed: scope.length, totalTopics: ranked.length, topics };
}

/** 原题按公司轮流挑，免得前几道全是收录最多的那家。 */
export function pickExamples(
  candidates: TopicExample[],
  max = MAX_EXAMPLES
): TopicExample[] {
  const byCompany = new Map<string, TopicExample[]>();
  for (const e of candidates) {
    const list = byCompany.get(e.company) || [];
    list.push(e);
    byCompany.set(e.company, list);
  }
  const queues = [...byCompany.values()];
  const out: TopicExample[] = [];
  for (let round = 0; out.length < max; round++) {
    let added = false;
    for (const q of queues) {
      if (round < q.length && out.length < max) {
        out.push(q[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** 请求体里的 keys：只收字符串、去重、截断。 */
export function sanitizeKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const k of raw) {
    if (typeof k !== 'string') continue;
    const key = k.trim();
    if (key && key.length <= 120 && /^[A-Za-z0-9_-]+$/.test(key)) out.add(key);
    if (out.size >= MAX_KEYS) break;
  }
  return [...out];
}
