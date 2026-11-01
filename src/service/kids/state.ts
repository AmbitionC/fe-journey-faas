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
