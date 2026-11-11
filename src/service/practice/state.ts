/**
 * 备考库做题记录（央国企 soe / 考公 civil）：文章内练习、整卷模考、错题本的校验与合并。
 *
 * 数据小（一个赛道一两百道题），存 Redis，不建表：库表改动要手动迁移（synchronize 已关）。
 * 合并规则和前端 src/components/Practice/practiceSync.ts 保持一致，改一边要改另一边：
 * - 练习：同一题取作答时间新的那次；「清空重做」记时间戳，早于它的作答丢掉。
 * - 模考：一篇卷子一份，取 updatedAt 新的；一样新时取已交卷的。
 * - 错题本：同一题取 updatedAt 新的；移出的题留一条 removedAt 记录，免得另一台设备又把它带回来。
 */

export const PRACTICE_MODULES = ['soe', 'civil'];

export interface PracticeAnswer {
  choice: string;
  correct: boolean;
  at: number;
}

export interface ExamState {
  answers: Record<string, string>;
  flags: string[];
  current: number;
  elapsedMs: number;
  submittedAt?: number;
  updatedAt: number;
}

export interface WrongState {
  articleKey: string;
  id: string;
  choice: string;
  addedAt: number;
  streak: number;
  updatedAt: number;
  removedAt?: number;
}

export interface PracticeState {
  practice: Record<string, Record<string, PracticeAnswer>>;
  cleared: Record<string, number>;
  exams: Record<string, ExamState>;
  wrong: Record<string, WrongState>;
}

const ARTICLE_RE = /^[\w一-龥.-]{1,100}$/;
const ID_RE = /^[\w-]{1,32}$/;
const CHOICE_RE = /^[A-H]?$/;
const MAX_ARTICLES = 300;
const MAX_QUESTIONS = 300;
const MAX_WRONG = 3000;
/** 单场模考计时上限：24 小时，防止灌进离谱的数 */
const MAX_ELAPSED = 24 * 3600 * 1000;

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const ts = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

export const emptyState = (): PracticeState => ({
  practice: {},
  cleared: {},
  exams: {},
  wrong: {},
});

function sanitizeExam(raw: unknown): ExamState | null {
  if (!isObj(raw)) return null;
  const answers: Record<string, string> = {};
  if (isObj(raw.answers)) {
    for (const [id, c] of Object.entries(raw.answers).slice(0, MAX_QUESTIONS)) {
      if (ID_RE.test(id) && typeof c === 'string' && c && CHOICE_RE.test(c))
        answers[id] = c;
    }
  }
  const flags = Array.isArray(raw.flags)
    ? [
        ...new Set(
          raw.flags.filter(
            (f: unknown) => typeof f === 'string' && ID_RE.test(f)
          ) as string[]
        ),
      ].slice(0, MAX_QUESTIONS)
    : [];
  const out: ExamState = {
    answers,
    flags,
    current: Math.min(ts(raw.current), MAX_QUESTIONS),
    elapsedMs: Math.min(ts(raw.elapsedMs), MAX_ELAPSED),
    updatedAt: ts(raw.updatedAt),
  };
  if (ts(raw.submittedAt)) out.submittedAt = ts(raw.submittedAt);
  return out;
}

/** 丢掉不认识的字段和不合规的条目；任何输入都返回一份合法状态 */
export function sanitizeState(raw: unknown): PracticeState {
  const out = emptyState();
  if (!isObj(raw)) return out;

  if (isObj(raw.cleared)) {
    for (const [key, at] of Object.entries(raw.cleared).slice(0, MAX_ARTICLES)) {
      if (ARTICLE_RE.test(key) && ts(at)) out.cleared[key] = ts(at);
    }
  }

  if (isObj(raw.practice)) {
    for (const [key, rec] of Object.entries(raw.practice).slice(
      0,
      MAX_ARTICLES
    )) {
      if (!ARTICLE_RE.test(key) || !isObj(rec)) continue;
      const answers: Record<string, PracticeAnswer> = {};
      for (const [id, a] of Object.entries(rec).slice(0, MAX_QUESTIONS)) {
        if (!ID_RE.test(id) || !isObj(a)) continue;
        if (typeof a.choice !== 'string' || !a.choice) continue;
        if (!CHOICE_RE.test(a.choice) || !ts(a.at)) continue;
        if (ts(a.at) <= (out.cleared[key] || 0)) continue;
        answers[id] = {
          choice: a.choice,
          correct: a.correct === true,
          at: ts(a.at),
        };
      }
      if (Object.keys(answers).length) out.practice[key] = answers;
    }
  }

  if (isObj(raw.exams)) {
    for (const [key, exam] of Object.entries(raw.exams).slice(0, MAX_ARTICLES)) {
      if (!ARTICLE_RE.test(key)) continue;
      const clean = sanitizeExam(exam);
      if (clean) out.exams[key] = clean;
    }
  }

  if (isObj(raw.wrong)) {
    for (const w of Object.values(raw.wrong).slice(0, MAX_WRONG)) {
      if (!isObj(w)) continue;
      if (typeof w.articleKey !== 'string' || !ARTICLE_RE.test(w.articleKey))
        continue;
      if (typeof w.id !== 'string' || !ID_RE.test(w.id)) continue;
      const entry: WrongState = {
        articleKey: w.articleKey,
        id: w.id,
        choice:
          typeof w.choice === 'string' && CHOICE_RE.test(w.choice)
            ? w.choice
            : '',
        addedAt: ts(w.addedAt),
        streak: Math.min(ts(w.streak), 9),
        updatedAt: ts(w.updatedAt) || ts(w.addedAt),
      };
      if (ts(w.removedAt)) entry.removedAt = ts(w.removedAt);
      out.wrong[`${entry.articleKey}#${entry.id}`] = entry;
    }
  }
  return out;
}

/** 两份状态合并：换设备、两台设备各做了一点，都不丢 */
export function mergeState(a: PracticeState, b: PracticeState): PracticeState {
  const out = emptyState();

  for (const src of [a, b]) {
    for (const [key, at] of Object.entries(src.cleared)) {
      out.cleared[key] = Math.max(out.cleared[key] || 0, at);
    }
  }

  for (const src of [a, b]) {
    for (const [key, rec] of Object.entries(src.practice)) {
      for (const [id, ans] of Object.entries(rec)) {
        if (ans.at <= (out.cleared[key] || 0)) continue;
        const cur = out.practice[key]?.[id];
        if (cur && cur.at >= ans.at) continue;
        (out.practice[key] = out.practice[key] || {})[id] = ans;
      }
    }
  }

  for (const src of [a, b]) {
    for (const [key, exam] of Object.entries(src.exams)) {
      const cur = out.exams[key];
      const newer =
        !cur ||
        exam.updatedAt > cur.updatedAt ||
        (exam.updatedAt === cur.updatedAt &&
          !!exam.submittedAt &&
          !cur.submittedAt);
      if (newer) out.exams[key] = exam;
    }
  }

  for (const src of [a, b]) {
    for (const [key, entry] of Object.entries(src.wrong)) {
      const cur = out.wrong[key];
      if (!cur || entry.updatedAt > cur.updatedAt) out.wrong[key] = entry;
    }
  }
  return out;
}

export const stateKey = (module: string, userId: string) =>
  `practice:state:${module}:${userId}`;
