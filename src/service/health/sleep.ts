/**
 * 睡眠样本 → 当晚睡眠（纯函数）。快捷指令「查找健康样本：睡眠分析」把每段样本按行发来：
 *   开始|结束|值      例：2026-10-11 23:42|2026-10-12 01:05|核心睡眠
 * 时间按北京时间、格式 yyyy-MM-dd HH:mm(:ss)（也接受 ISO）。也接受 [{start,end,value}] 数组。
 *
 * - 「在床上 / 清醒」不算睡着，其余（核心 / 深度 / 快速动眼 / 睡眠中 / Asleep…）都算；
 * - iPhone 和 Watch 会重复记同一段，按时间取并集，不重复累加；
 * - 只看 date 这天醒来的那一觉：前一天 18:00 到当天 14:00 之间的样本。
 */

export interface SleepNight {
  hours: number;
  /** 入睡 / 醒来（北京时间 yyyy-MM-dd HH:mm） */
  start: string;
  end: string;
  segments: number;
}

const NOT_ASLEEP = /床|清醒|醒着|awake|in\s*bed|inbed/i;

/** 解析成「自 1970 起的分钟数」（按北京时间当作本地时间，不做时区换算）。 */
function toMin(s: string): number | null {
  const t = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (m) {
    // 带时区的 ISO（Z / +08:00）：换算到北京时间
    const tz = /(Z|[+-]\d{2}:?\d{2})$/.exec(t);
    if (tz) {
      const ms = Date.parse(t);
      if (Number.isNaN(ms)) return null;
      return Math.floor((ms + 8 * 3600 * 1000) / 60000);
    }
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000);
  }
  // 中文系统默认格式兜底：2026年10月12日 07:31
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/.exec(t);
  if (m) return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000);
  return null;
}

const fmt = (min: number) => new Date(min * 60000).toISOString().slice(0, 16).replace('T', ' ');

export function parseSleepSamples(input: unknown, date: string): SleepNight | null {
  let rows: Array<{ start: string; end: string; value: string }> = [];
  if (Array.isArray(input)) rows = input.map((x: any) => ({ start: x?.start, end: x?.end, value: String(x?.value ?? '') }));
  else if (typeof input === 'string')
    rows = input
      .split(/\r?\n/)
      .map(l => l.split('|'))
      .filter(p => p.length >= 2)
      .map(p => ({ start: p[0], end: p[1], value: p[2] || '' }));
  const dayStart = toMin(`${date} 00:00`) as number;
  const winFrom = dayStart - 6 * 60; // 前一天 18:00
  const winTo = dayStart + 14 * 60; // 当天 14:00
  const iv = rows
    .filter(r => !NOT_ASLEEP.test(r.value))
    .map(r => [toMin(r.start), toMin(r.end)] as [number | null, number | null])
    .filter((x): x is [number, number] => x[0] != null && x[1] != null && x[1] > x[0])
    .map(([s, e]) => [Math.max(s, winFrom), Math.min(e, winTo)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  if (!iv.length) return null;
  const merged: Array<[number, number]> = [];
  for (const [s, e] of iv) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const total = merged.reduce((a, [s, e]) => a + (e - s), 0);
  return {
    hours: Math.round((total / 60) * 100) / 100,
    start: fmt(merged[0][0]),
    end: fmt(merged[merged.length - 1][1]),
    segments: merged.length,
  };
}
