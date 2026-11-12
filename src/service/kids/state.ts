/**
 * 栗栗学英语（little-circle-web）的学习计划和阅读进度：校验与合并。
 *
 * 数据很小（一个孩子的计划 + 每天读了哪几本书），存 Redis，不建表：
 * 库表改动要手动迁移（synchronize 已关），为两段 JSON 不值得。
 * 纯函数单独放这里，方便单测。
 */

export type AgeBand = '3-4' | '4-5' | '5-6';

export interface KidsProfile {
  nickname: string;
  ageBand: AgeBand;
  minutesPerDay: 5 | 10 | 15;
  startDate: string;
  lockToPlan: boolean;
}

export interface DayRecord {
  done: string[];
  words: string[];
}

export type KidsProgress = Record<string, DayRecord>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9_-]{1,32}$/i;
/** 最多留多少天：两年够用，也防止有人往里灌数据 */
export const MAX_DAYS = 730;
const MAX_PER_DAY = 50;

const cleanList = (v: unknown, ok: (s: string) => boolean): string[] => {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x === 'string' && ok(x)) out.add(x);
    if (out.size >= MAX_PER_DAY) break;
  }
  return [...out];
};

/** 不合法返回 null；昵称只保留前 12 个字 */
export function sanitizeProfile(raw: unknown): KidsProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nickname =
    typeof r.nickname === 'string' ? r.nickname.trim().slice(0, 12) : '';
  if (!nickname) return null;
  if (!['3-4', '4-5', '5-6'].includes(r.ageBand as string)) return null;
  if (![5, 10, 15].includes(r.minutesPerDay as number)) return null;
  if (typeof r.startDate !== 'string' || !DATE_RE.test(r.startDate))
    return null;
  return {
    nickname,
    ageBand: r.ageBand as AgeBand,
    minutesPerDay: r.minutesPerDay as 5 | 10 | 15,
    startDate: r.startDate,
    lockToPlan: r.lockToPlan === true,
  };
}

/** 丢掉不认识的日期和条目，只留最近 MAX_DAYS 天 */
export function sanitizeProgress(raw: unknown): KidsProgress {
  const out: KidsProgress = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const days = Object.keys(raw as object)
    .filter(d => DATE_RE.test(d))
    .sort()
    .slice(-MAX_DAYS);
  for (const d of days) {
    const rec = (raw as Record<string, any>)[d] || {};
    const done = cleanList(rec.done, s => ID_RE.test(s));
    const words = cleanList(rec.words, s => s.length > 0 && s.length <= 40);
    if (done.length || words.length) out[d] = { done, words };
  }
  return out;
}

/** 两边取并集：换手机、两台设备各读了一点，都不丢 */
export function mergeProgress(a: KidsProgress, b: KidsProgress): KidsProgress {
  const merged: Record<string, DayRecord> = {};
  for (const src of [a, b]) {
    for (const [d, rec] of Object.entries(src)) {
      const cur = merged[d] || { done: [], words: [] };
      merged[d] = {
        done: [...new Set([...cur.done, ...rec.done])],
        words: [...new Set([...cur.words, ...rec.words])],
      };
    }
  }
  return sanitizeProgress(merged);
}

export const profileKey = (userId: string) => `kids:profile:${userId}`;
export const progressKey = (userId: string) => `kids:progress:${userId}`;

/**
 * 阅读状态（多端同步）：每本书读到第几页、读完过几次、最后在读哪本、阅读偏好。
 * 读完次数存成「读完那一刻的时间戳」列表，两台设备合并时取并集，不会重复计数。
 */
export interface KidsBookState {
  /** 读到第几页（从 0 开始） */
  page: number;
  /** 这一页记录的时间（毫秒） */
  at: number;
  /** 每次读完的时间戳（毫秒） */
  done: number[];
}

export interface KidsPrefs {
  /** 读完自动接着读下一本 */
  autoNext: boolean;
  /** 语速 */
  rate: 0.75 | 1;
  /** 显示中文 */
  zh: boolean;
  /** 牛津树书架停在第几级 */
  ortLevel: number;
  /** 偏好改动的时间（毫秒），合并时新的覆盖旧的 */
  at: number;
}

export interface KidsReading {
  books: Record<string, KidsBookState>;
  /** 最后在读的书 */
  last: { id: string; page: number; at: number } | null;
  prefs: KidsPrefs | null;
}

export const MAX_BOOKS = 400;
const MAX_DONE = 30;
const MAX_PAGE = 300;
/** 时间戳只认 2024 年以后、不晚于现在一天的，防止乱填 */
const okTime = (t: unknown): t is number =>
  typeof t === 'number' &&
  Number.isFinite(t) &&
  t > 1704067200000 &&
  t < Date.now() + 86400000;
const okPage = (p: unknown): p is number =>
  typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= MAX_PAGE;

export function sanitizeReading(raw: unknown): KidsReading {
  const out: KidsReading = { books: {}, last: null, prefs: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, any>;
  const books =
    r.books && typeof r.books === 'object' && !Array.isArray(r.books)
      ? r.books
      : {};
  const entries: [string, KidsBookState][] = [];
  for (const [id, b] of Object.entries(books as Record<string, any>)) {
    if (!ID_RE.test(id) || !b || typeof b !== 'object') continue;
    const done = [
      ...new Set(
        (Array.isArray(b.done) ? b.done : []).filter(okTime) as number[]
      ),
    ]
      .sort((x, y) => x - y)
      .slice(-MAX_DONE);
    const page = okPage(b.page) ? b.page : 0;
    const at = okTime(b.at) ? b.at : done[done.length - 1] || 0;
    if (!at && !done.length) continue;
    entries.push([id, { page, at, done }]);
  }
  entries
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, MAX_BOOKS)
    .forEach(([id, b]) => (out.books[id] = b));
  const l = r.last;
  if (
    l &&
    typeof l === 'object' &&
    ID_RE.test(l.id) &&
    okPage(l.page) &&
    okTime(l.at)
  ) {
    out.last = { id: l.id, page: l.page, at: l.at };
  }
  const p = r.prefs;
  if (p && typeof p === 'object' && okTime(p.at)) {
    out.prefs = {
      autoNext: p.autoNext !== false,
      rate: p.rate === 0.75 ? 0.75 : 1,
      zh: p.zh !== false,
      ortLevel:
        Number.isInteger(p.ortLevel) && p.ortLevel >= 1 && p.ortLevel <= 9
          ? p.ortLevel
          : 1,
      at: p.at,
    };
  }
  return out;
}

/** 合并两台设备的阅读状态：页码和「最后在读」取较新的，读完记录取并集，偏好取较新的 */
export function mergeReading(a: KidsReading, b: KidsReading): KidsReading {
  const books: Record<string, KidsBookState> = { ...a.books };
  for (const [id, x] of Object.entries(b.books)) {
    const y = books[id];
    if (!y) {
      books[id] = x;
      continue;
    }
    const newer = x.at >= y.at ? x : y;
    books[id] = {
      page: newer.page,
      at: newer.at,
      done: [...new Set([...y.done, ...x.done])],
    };
  }
  const pick = <T extends { at: number } | null>(p: T, q: T): T =>
    !p ? q : !q ? p : q.at >= p.at ? q : p;
  return sanitizeReading({
    books,
    last: pick(a.last, b.last),
    prefs: pick(a.prefs, b.prefs),
  });
}

export const readingKey = (userId: string) => `kids:reading:${userId}`;
