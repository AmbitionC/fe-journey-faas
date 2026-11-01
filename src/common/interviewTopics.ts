import { createHash } from 'crypto';
import { cleanSnippet, navIndex } from '../mcp/tools/agent';

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

export interface QuestionBlock {
  key: string;
  question: string;
  /** 题目下第一段答题思路（纯文本，过长截断）；没有则为空串 */
  answer: string;
}

export interface ArticleQuestions {
  articleKey: string;
  title: string;
  company: string;
  questions: QuestionBlock[];
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

/** 题单里每道题附的答题要点最长多少字。 */
export const MAX_ANSWER_CHARS = 300;

/**
 * 与 Skill 的 extractQuestions 同一口径取题（同一正则、同样跳过「背景学习入口」、同样去掉序号前缀），
 * 另外带上题目下第一段答题思路，给题单用。
 */
export function extractQuestionBlocks(content: string): QuestionBlock[] {
  const out: QuestionBlock[] = [];
  const re =
    /<details[^>]*data-knowledge-key="([^"]+)"[^>]*>\s*<summary>([\s\S]*?)<\/summary>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    let q = cleanSnippet(m[2]) || '';
    if (/^（\d+）\s*背景学习入口/.test(q)) continue;
    q = q
      .replace(/^（\d+）\s*/, '')
      .replace(/^同一原问的复习入口（[^）]*）：/, '')
      .replace(/^[一二三四五]面：/, '')
      .trim();
    if (q) out.push({ key: m[1], question: q, answer: answerAfter(content, re.lastIndex) });
  }
  return out;
}

/** 题目 </details> 之后、下一道题或下一个标题之前的第一段正文。 */
function answerAfter(content: string, from: number): string {
  const close = content.indexOf('</details>', from);
  if (close < 0) return '';
  const rest = content.slice(close + '</details>'.length);
  const stop = rest.search(/<details|\n#{1,6}\s/);
  const body = stop < 0 ? rest : rest.slice(0, stop);
  for (const para of body.split(/\n\s*\n/)) {
    const raw = para.trim();
    // 跳过知识导航、纯链接、图片和引用块；<p> 包着的短答照收
    if (!raw || /^(\[|!\[|知识导航|>)/.test(raw)) continue;
    const text = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<\/?(?:strong|em|b|i|code|span|a)\b[^>]*>/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return clip(text, MAX_ANSWER_CHARS);
  }
  return '';
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('。', max);
  return cut >= max * 0.4 ? text.slice(0, cut + 1) : `${text.slice(0, max)}…`;
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
    const questions = extractQuestionBlocks(content);
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

export interface SheetQuestion {
  question: string;
  answer: string;
  company: string;
  title: string;
  articleKey: string;
}

export interface SheetTopic {
  topic: string;
  knowledgeKey: string;
  articles: number;
  companies: string[];
  questions: SheetQuestion[];
}

/** 知识库目录里某个一级分类下的全部知识点 key（如「项目与职业」career）。 */
export function leafKeysUnder(navData: any[], topKey: string): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: any[]) =>
    (nodes || []).forEach(n =>
      n?.isLeaf ? out.add(n.key) : walk(n?.children)
    );
  walk((navData || []).filter(n => n?.key === topKey));
  return out;
}

/**
 * 题单：给定那批面经里的全部题，按考点归组（考点顺序与考点榜相同：篇数→公司数→key，
 * 简历与面试这类非技术考点放最后），
 * 组内同一道题（文字相同）只留一次，按公司轮流排。
 */
export function buildSheet(
  index: ArticleQuestions[],
  opts: {
    keys?: string[];
    knowledgeTitles: Map<string, { title: string }>;
    /** 放到最后的考点（简历、自我介绍、反问这类非技术题），见 leafKeysUnder */
    lastKeys?: Set<string>;
  }
): { articlesAnalyzed: number; totalQuestions: number; topics: SheetTopic[] } {
  const wanted = opts.keys?.length ? new Set(opts.keys) : null;
  const scope = wanted ? index.filter(a => wanted.has(a.articleKey)) : index;
  type Acc = {
    articles: Set<string>;
    companies: Map<string, number>;
    questions: SheetQuestion[];
    seen: Set<string>;
  };
  const acc = new Map<string, Acc>();
  for (const article of scope) {
    for (const q of article.questions) {
      const t = acc.get(q.key) || {
        articles: new Set<string>(),
        companies: new Map<string, number>(),
        questions: [],
        seen: new Set<string>(),
      };
      if (!t.articles.has(article.articleKey)) {
        t.articles.add(article.articleKey);
        if (article.company)
          t.companies.set(
            article.company,
            (t.companies.get(article.company) || 0) + 1
          );
      }
      const norm = q.question.replace(/[\s？?。.!！]/g, '');
      if (!t.seen.has(norm)) {
        t.seen.add(norm);
        t.questions.push({
          question: q.question,
          answer: q.answer,
          company: article.company,
          title: article.title,
          articleKey: article.articleKey,
        });
      }
      acc.set(q.key, t);
    }
  }
  const last = (key: string) => (opts.lastKeys?.has(key) ? 1 : 0);
  const topics = [...acc.entries()]
    .sort(
      (x, y) =>
        last(x[0]) - last(y[0]) ||
        y[1].articles.size - x[1].articles.size ||
        y[1].companies.size - x[1].companies.size ||
        x[0].localeCompare(y[0])
    )
    .map(([key, t]) => ({
      topic: opts.knowledgeTitles.get(key)?.title || key,
      knowledgeKey: key,
      articles: t.articles.size,
      companies: [...t.companies.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([c]) => c),
      questions: pickExamples(t.questions, Infinity),
    }));
  return {
    articlesAnalyzed: scope.length,
    totalQuestions: topics.reduce((n, t) => n + t.questions.length, 0),
    topics,
  };
}

/** 题单的标识：同一批面经（不论顺序）算同一份，免费额度重复打开不再扣。 */
export function sheetSignature(keys: string[]): string {
  return createHash('sha1').update([...keys].sort().join(',')).digest('hex').slice(0, 16);
}

/**
 * 未开通会员导出题单时的额度判定（每月 1 份）：
 * 本月没用过 → 未确认先问（needsConfirm），确认了就领（claim）；
 * 用过且是同一批面经 → 照常给（ok）；用在了别的题单上 → 锁住（locked）。
 */
export function decideSheetQuota(
  used: { sig?: string } | null,
  sig: string,
  confirm: boolean
): 'ok' | 'claim' | 'needsConfirm' | 'locked' {
  if (!used) return confirm ? 'claim' : 'needsConfirm';
  return used.sig === sig ? 'ok' : 'locked';
}

/** 原题按公司轮流挑，免得前几道全是收录最多的那家。 */
export function pickExamples<T extends { company: string }>(
  candidates: T[],
  max = MAX_EXAMPLES
): T[] {
  const byCompany = new Map<string, T[]>();
  for (const e of candidates) {
    const list = byCompany.get(e.company) || [];
    list.push(e);
    byCompany.set(e.company, list);
  }
  const queues = [...byCompany.values()];
  const out: T[] = [];
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
