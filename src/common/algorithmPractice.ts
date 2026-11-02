import type { ArticleQuestions } from './interviewTopics';

/**
 * 算法「练习中心」的纯函数：面经引用匹配、连续练习天数、动态题单、今日推荐。
 * 取数在 service/algorithm/index.ts，这里不碰数据库，便于单测。
 *
 * 设计取舍（对标字节 MarsCode AI 刷题，2026-11-02）：
 * - 他们的「字节真题」靠自家题库；我们的差异点是**面经**——算法题在哪些公司的面经里被问到，
 *   直接从面经题目索引（InterviewQuestionIndexService）里按题名匹配，不另建表、不人工维护。
 * - 推荐只用做题记录做确定性规则（上次没过 / 巩固知识点 / 面经高频未做），不引入模型，
 *   理由必须能一句话说清，用户才信。
 */

// ---------- 面经引用 ----------

export interface InterviewRefExample {
  articleKey: string;
  title: string;
  company: string;
  question: string;
}

export interface InterviewRefs {
  /** 出现在几篇面经里（同一篇只算一次） */
  count: number;
  /** 问过它的公司，按篇数降序 */
  companies: { name: string; count: number }[];
  /** 原问法样例（不同面经、公司轮流挑） */
  examples: InterviewRefExample[];
}

export const MAX_REF_EXAMPLES = 5;

/** 题名归一化：去空白与标点、小写，「LRU 缓存」与「lru缓存」视为同一题。 */
export function normalizeTitle(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 罗马数字后缀的题（「反转链表 II」）去掉后缀后也参与匹配，面经里一般不写编号。 */
function titleVariants(title: string): string[] {
  const base = normalizeTitle(title);
  const out = new Set<string>();
  if (base.length >= 2) out.add(base);
  const stripped = normalizeTitle(title.replace(/\s*(?:I{1,3}|IV|V)\s*$/i, ''));
  if (stripped.length >= 2 && stripped !== base) out.add(stripped);
  return [...out];
}

/** 公司轮流挑样例：避免五条全是同一家。 */
function pickRefExamples(
  all: InterviewRefExample[],
  max = MAX_REF_EXAMPLES
): InterviewRefExample[] {
  const byCompany = new Map<string, InterviewRefExample[]>();
  for (const e of all) {
    const list = byCompany.get(e.company) || [];
    list.push(e);
    byCompany.set(e.company, list);
  }
  const queues = [...byCompany.values()];
  const out: InterviewRefExample[] = [];
  let progressed = true;
  while (out.length < max && progressed) {
    progressed = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        progressed = true;
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/**
 * 把题库里的题与面经题目索引对上：面经里某道题的问法包含算法题题名即算引用。
 * 只看面经里被标成「题目」的句子（不扫全文），避免正文闲聊里的词误伤。
 */
export function matchInterviewRefs(
  problems: { slug: string; title: string }[],
  index: ArticleQuestions[]
): Map<string, InterviewRefs> {
  const variants = problems
    .map(p => ({ slug: p.slug, keys: titleVariants(p.title) }))
    .filter(p => p.keys.length);
  type Acc = {
    articles: Set<string>;
    companies: Map<string, number>;
    examples: InterviewRefExample[];
  };
  const acc = new Map<string, Acc>();
  for (const article of index) {
    const normalizedQuestions = article.questions.map(q => ({
      raw: q.question,
      norm: normalizeTitle(q.question),
    }));
    for (const p of variants) {
      const hit = normalizedQuestions.find(q =>
        p.keys.some(k => q.norm.includes(k))
      );
      if (!hit) continue;
      const a = acc.get(p.slug) || {
        articles: new Set<string>(),
        companies: new Map<string, number>(),
        examples: [],
      };
      if (!a.articles.has(article.articleKey)) {
        a.articles.add(article.articleKey);
        if (article.company)
          a.companies.set(
            article.company,
            (a.companies.get(article.company) || 0) + 1
          );
        a.examples.push({
          articleKey: article.articleKey,
          title: article.title,
          company: article.company,
          question: hit.raw,
        });
      }
      acc.set(p.slug, a);
    }
  }
  const out = new Map<string, InterviewRefs>();
  acc.forEach((a, slug) => {
    out.set(slug, {
      count: a.articles.size,
      companies: [...a.companies.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([name, count]) => ({ name, count })),
      examples: pickRefExamples(a.examples),
    });
  });
  return out;
}

// ---------- 练习节奏 ----------

const DAY_MS = 86400000;
/** 练习日按北京时间算，用户都在国内；UTC 23:30 提交算第二天才是用户的直觉。 */
const TZ_OFFSET_MS = 8 * 3600000;

export function toDayKey(d: Date | string | number): string {
  const t = new Date(d).getTime() + TZ_OFFSET_MS;
  return new Date(t).toISOString().slice(0, 10);
}

function shiftDay(key: string, delta: number): string {
  const t = Date.parse(`${key}T00:00:00Z`) + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export interface StreakInfo {
  /** 连续练习天数；今天没练则从昨天往前数（今天还没结束，不该清零） */
  current: number;
  longest: number;
  practicedToday: boolean;
}

/** dayKeys 为有提交的日期集合（YYYY-MM-DD，北京时间）。 */
export function computeStreak(
  dayKeys: Iterable<string>,
  today: string
): StreakInfo {
  const days = new Set(dayKeys);
  const practicedToday = days.has(today);
  let current = 0;
  let cursor = practicedToday ? today : shiftDay(today, -1);
  while (days.has(cursor)) {
    current += 1;
    cursor = shiftDay(cursor, -1);
  }
  let longest = 0;
  const sorted = [...days].sort();
  let run = 0;
  let prev: string | null = null;
  for (const k of sorted) {
    run = prev && shiftDay(prev, 1) === k ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = k;
  }
  return { current, longest, practicedToday };
}

/** 近 N 天每日提交数，按日期升序，给热力图用。 */
export function buildActivity(
  submissions: { createTime?: Date | string; status: string }[],
  today: string,
  days = 84
): { date: string; count: number; solved: number }[] {
  const map = new Map<string, { count: number; solved: number }>();
  for (const s of submissions) {
    if (!s.createTime) continue;
    const k = toDayKey(s.createTime);
    const v = map.get(k) || { count: 0, solved: 0 };
    v.count += 1;
    if (s.status === 'accepted') v.solved += 1;
    map.set(k, v);
  }
  const out: { date: string; count: number; solved: number }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = shiftDay(today, -i);
    const v = map.get(date);
    out.push({ date, count: v?.count || 0, solved: v?.solved || 0 });
  }
  return out;
}

// ---------- 动态题单 ----------

export interface ProblemLite {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  orderNum: number;
  tags: { id: string; name: string }[];
  listSlugs?: string[] | null;
}

export interface ProblemListMeta {
  slug: string;
  title: string;
  description: string;
  /** builtin=系统生成；manual=后台题单归属 */
  kind: 'builtin' | 'topic' | 'manual';
  problemSlugs: string[];
}

export const MANUAL_LIST_META: Record<
  string,
  { title: string; description: string }
> = {
  'campus-hot': {
    title: '校招高频',
    description: '校招笔试面试最常考的那批题',
  },
  'by-topic': {
    title: '按知识点',
    description: '按数据结构与算法思想分组练习',
  },
  agent: { title: 'Agent 专项', description: 'Agent 工程里会真用到的算法题' },
};

const SWORD_OFFER_TAG = '剑指 Offer';
/** 标签至少挂几道题才单独成专题，太少的没练习价值 */
const TOPIC_MIN_PROBLEMS = 3;

/**
 * 题单 = 面经高频（自动）+ 校招高频（自动兜底：LeetCode 热门 20）+ 剑指 Offer（标签）
 *      + 知识点专题（标签自动生成）+ 后台人工题单（listSlugs）。
 * 后台填了人工题单就以人工为准，没填时用自动规则兜底，空题单不下发。
 */
export function buildProblemLists(
  problems: ProblemLite[],
  refs: Map<string, InterviewRefs>
): ProblemListMeta[] {
  const out: ProblemListMeta[] = [];
  const manual: Record<string, string[]> = {};
  for (const p of problems) {
    for (const ls of Array.isArray(p.listSlugs) ? p.listSlugs : []) {
      (manual[ls] ||= []).push(p.slug);
    }
  }

  const hot = problems
    .filter(p => (refs.get(p.slug)?.count || 0) > 0)
    .sort(
      (a, b) =>
        (refs.get(b.slug)?.count || 0) - (refs.get(a.slug)?.count || 0) ||
        a.orderNum - b.orderNum
    )
    .map(p => p.slug);
  if (hot.length)
    out.push({
      slug: 'interview-hot',
      title: '面经高频',
      description: '真实面经里被问到过的算法题，按出现篇数排序',
      kind: 'builtin',
      problemSlugs: hot,
    });

  const campus =
    manual['campus-hot'] ||
    problems
      .filter(p => !p.tags.some(t => t.name === SWORD_OFFER_TAG))
      .sort((a, b) => a.orderNum - b.orderNum)
      .map(p => p.slug);
  if (campus.length)
    out.push({
      slug: 'campus-hot',
      title: MANUAL_LIST_META['campus-hot'].title,
      description: MANUAL_LIST_META['campus-hot'].description,
      kind: manual['campus-hot'] ? 'manual' : 'builtin',
      problemSlugs: campus,
    });

  const sword = problems
    .filter(p => p.tags.some(t => t.name === SWORD_OFFER_TAG))
    .sort((a, b) => a.orderNum - b.orderNum)
    .map(p => p.slug);
  if (sword.length)
    out.push({
      slug: 'sword-offer',
      title: '剑指 Offer',
      description: '剑指 Offer 第 2 版全部 75 题，按原书顺序',
      kind: 'builtin',
      problemSlugs: sword,
    });

  for (const [slug, meta] of Object.entries(MANUAL_LIST_META)) {
    if (slug === 'campus-hot' || slug === 'by-topic') continue;
    if (manual[slug]?.length)
      out.push({
        slug,
        title: meta.title,
        description: meta.description,
        kind: 'manual',
        problemSlugs: manual[slug],
      });
  }

  const byTag = new Map<string, { name: string; slugs: string[] }>();
  for (const p of [...problems].sort((a, b) => a.orderNum - b.orderNum)) {
    for (const t of p.tags) {
      if (t.name === SWORD_OFFER_TAG) continue;
      const v = byTag.get(String(t.id)) || { name: t.name, slugs: [] };
      v.slugs.push(p.slug);
      byTag.set(String(t.id), v);
    }
  }
  const topics = [...byTag.entries()]
    .filter(([, v]) => v.slugs.length >= TOPIC_MIN_PROBLEMS)
    .sort(
      (a, b) =>
        b[1].slugs.length - a[1].slugs.length ||
        a[1].name.localeCompare(b[1].name)
    );
  for (const [id, v] of topics) {
    out.push({
      slug: `topic-${id}`,
      title: v.name,
      description: `${v.name}专题，共 ${v.slugs.length} 题`,
      kind: 'topic',
      problemSlugs: v.slugs,
    });
  }
  return out;
}

// ---------- 今日推荐 ----------

export type ProblemStatus = 'accepted' | 'attempted';

export interface Recommendation {
  slug: string;
  reason: string;
  /** redo=上次没过/标记重做；topic=巩固知识点；interview=面经高频；next=顺序下一题 */
  kind: 'redo' | 'topic' | 'interview' | 'next';
}

/**
 * 三条确定性规则各出一题，不够用顺序下一题补齐：
 * 1. 上次没过或标了重做的题——最该回头看的；
 * 2. 最近通过的那道题所属标签里下一道没做的——趁热巩固；
 * 3. 面经里出现最多、还没做的——离面试最近。
 */
export function buildRecommendations(opts: {
  problems: ProblemLite[];
  statusMap: Record<string, ProblemStatus>;
  flags: Record<string, 'favorite' | 'redo'>;
  refs: Map<string, InterviewRefs>;
  /** 最近一次通过的题 slug（可无） */
  lastAcceptedSlug?: string | null;
  limit?: number;
}): Recommendation[] {
  const limit = opts.limit ?? 3;
  const ordered = [...opts.problems].sort((a, b) => a.orderNum - b.orderNum);
  const solved = (p: ProblemLite) =>
    opts.statusMap[String(p.id)] === 'accepted';
  const picked = new Set<string>();
  const out: Recommendation[] = [];
  const push = (
    p: ProblemLite | undefined,
    reason: string,
    kind: Recommendation['kind']
  ) => {
    if (!p || picked.has(p.slug) || out.length >= limit) return;
    picked.add(p.slug);
    out.push({ slug: p.slug, reason, kind });
  };

  const redo =
    ordered.find(p => opts.flags[p.slug] === 'redo' && !solved(p)) ||
    ordered.find(p => opts.flags[p.slug] === 'redo') ||
    ordered.find(p => opts.statusMap[String(p.id)] === 'attempted');
  if (redo)
    push(
      redo,
      opts.flags[redo.slug] === 'redo'
        ? '你标记了重做'
        : '上次没通过，再试一次',
      'redo'
    );

  const last = opts.lastAcceptedSlug
    ? ordered.find(p => p.slug === opts.lastAcceptedSlug)
    : undefined;
  if (last) {
    const tag = last.tags.find(t => t.name !== SWORD_OFFER_TAG) || last.tags[0];
    if (tag) {
      const next = ordered.find(
        p =>
          p.slug !== last.slug &&
          !picked.has(p.slug) &&
          !solved(p) &&
          p.tags.some(t => String(t.id) === String(tag.id))
      );
      push(next, `刚通过「${last.title}」，趁热巩固${tag.name}`, 'topic');
    }
  }

  const hot = ordered
    .filter(
      p =>
        !picked.has(p.slug) &&
        !solved(p) &&
        (opts.refs.get(p.slug)?.count || 0) > 0
    )
    .sort(
      (a, b) =>
        (opts.refs.get(b.slug)?.count || 0) -
        (opts.refs.get(a.slug)?.count || 0)
    )[0];
  if (hot) {
    const r = opts.refs.get(hot.slug)!;
    const who = r.companies[0]?.name ? `${r.companies[0].name}等` : '';
    push(hot, `${who}${r.count} 篇面经问过，还没做`, 'interview');
  }

  for (const p of ordered) {
    if (out.length >= limit) break;
    if (!solved(p)) push(p, '按顺序往下练', 'next');
  }
  return out;
}

/** 同标签的相似题（排除自己、排除「剑指 Offer」这种集合标签），按序号就近。 */
export function findSimilar(
  problem: ProblemLite,
  problems: ProblemLite[],
  limit = 4
): ProblemLite[] {
  const tagIds = new Set(
    problem.tags.filter(t => t.name !== SWORD_OFFER_TAG).map(t => String(t.id))
  );
  if (!tagIds.size) return [];
  return problems
    .filter(
      p => p.slug !== problem.slug && p.tags.some(t => tagIds.has(String(t.id)))
    )
    .map(p => ({
      p,
      shared: p.tags.filter(t => tagIds.has(String(t.id))).length,
      dist: Math.abs(p.orderNum - problem.orderNum),
    }))
    .sort((a, b) => b.shared - a.shared || a.dist - b.dist)
    .slice(0, limit)
    .map(x => x.p);
}
