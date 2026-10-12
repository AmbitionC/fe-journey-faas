import { daysBetween } from './logic';

/**
 * 时间账（纯函数，无 IO）。时间和钱一样是资产：先按人生目标定每周预算，再看实际花在哪。
 *
 * - 作息模板（rule.kind=template）每周循环：assume=true 的段（上班/睡觉/周末陪娃）没实报时按「模板推定」计入；
 *   assume=false 的是计划（副业/训练），只是安排，**只有实报了才算做了**——不拿计划冒充事实。
 * - 实报段（block.kind=actual）覆盖同时段的模板；某天的预先安排（block.kind=plan）只进日程、不进时间账。
 * - 时间用「当天第几分钟」表示；end > 1440 表示跨午夜（如 23:30→次日 07:30 = 1410→1890）。
 */

export const CATEGORIES = ['睡眠', '主业', '副业', '家庭', '健康', '成长', '休闲', '杂务', '其他'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface TimeRule {
  key: string;
  kind: 'budget' | 'template';
  category: string;
  title: string | null;
  /** 1=周一 … 7=周日（模板用） */
  days: number[];
  startMin: number | null;
  endMin: number | null;
  assume: boolean;
  hoursPerWeek: number | null;
}

export interface TimeBlock {
  id?: number;
  date: string;
  startMin: number;
  endMin: number;
  category: string;
  title: string | null;
  kind: 'actual' | 'plan';
  source?: string;
}

export interface ScreenRecord {
  period: 'week' | 'day';
  start: string;
  avgMin: number;
  pickups: number | null;
  categories: Record<string, number>;
  apps: Array<{ name: string; min: number }>;
}

const shift = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** 1=周一 … 7=周日 */
export const dow = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
export const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface DaySeg {
  startMin: number;
  endMin: number;
  category: string;
  title: string | null;
  /** template-assume 模板推定 / template-plan 模板里的计划 / plan 当天预先安排 / actual 实报 */
  origin: 'template-assume' | 'template-plan' | 'plan' | 'actual';
  ruleKey?: string;
  blockId?: number;
}

/**
 * 某天（0–1440）的模板段：当天开始的段 + 前一天跨午夜延续过来的部分，裁到当天范围内。
 */
export function templateFor(date: string, rules: TimeRule[]): DaySeg[] {
  const out: DaySeg[] = [];
  const d = dow(date);
  const prev = dow(shift(date, -1));
  for (const r of rules) {
    if (r.kind !== 'template' || r.startMin == null || r.endMin == null) continue;
    const end = r.endMin > r.startMin ? r.endMin : r.endMin + 1440;
    const origin = r.assume ? 'template-assume' : 'template-plan';
    if (r.days.includes(d)) out.push({ startMin: r.startMin, endMin: Math.min(end, 1440), category: r.category, title: r.title, origin, ruleKey: r.key });
    if (end > 1440 && r.days.includes(prev))
      out.push({ startMin: 0, endMin: end - 1440, category: r.category, title: r.title, origin, ruleKey: r.key });
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

/** 某天的块（含前一天跨午夜延续过来的部分），裁到当天。 */
function blocksFor(date: string, blocks: TimeBlock[], kind: 'actual' | 'plan'): DaySeg[] {
  const out: DaySeg[] = [];
  for (const b of blocks) {
    if (b.kind !== kind) continue;
    const origin = kind;
    if (b.date === date) out.push({ startMin: b.startMin, endMin: Math.min(b.endMin, 1440), category: b.category, title: b.title, origin, blockId: b.id });
    if (b.date === shift(date, -1) && b.endMin > 1440)
      out.push({ startMin: 0, endMin: b.endMin - 1440, category: b.category, title: b.title, origin, blockId: b.id });
  }
  return out;
}

const overlap = (a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) =>
  Math.max(0, Math.min(a.endMin, b.endMin) - Math.max(a.startMin, b.startMin));

/**
 * 一天的时间分配（分钟）：先铺模板推定段，再用实报段覆盖。
 * 返回每类分钟数（区分实报 / 推定）与未记录分钟。
 */
export function dayLedger(date: string, rules: TimeRule[], blocks: TimeBlock[]) {
  const slot: Array<{ cat: string; reported: boolean } | null> = new Array(1440).fill(null);
  for (const s of templateFor(date, rules).filter(x => x.origin === 'template-assume'))
    for (let m = s.startMin; m < s.endMin; m++) slot[m] = { cat: s.category, reported: false };
  const actual = blocksFor(date, blocks, 'actual');
  for (const s of actual) for (let m = s.startMin; m < s.endMin; m++) slot[m] = { cat: s.category, reported: true };
  const reported: Record<string, number> = {};
  const assumed: Record<string, number> = {};
  let unrecorded = 0;
  for (const x of slot) {
    if (!x) unrecorded++;
    else if (x.reported) reported[x.cat] = (reported[x.cat] || 0) + 1;
    else assumed[x.cat] = (assumed[x.cat] || 0) + 1;
  }
  return { date, reported, assumed, unrecorded, hasActual: actual.length > 0 };
}

export interface PlanCheck {
  date: string;
  category: string;
  title: string | null;
  startMin: number;
  endMin: number;
  done: boolean;
}

/** 某天的计划（模板里的计划段 + 当天预先安排）是否做了：同类实报段覆盖到一半以上算做了。 */
export function planChecks(date: string, rules: TimeRule[], blocks: TimeBlock[]): PlanCheck[] {
  const plans = [...templateFor(date, rules).filter(x => x.origin === 'template-plan'), ...blocksFor(date, blocks, 'plan')];
  const actual = blocksFor(date, blocks, 'actual');
  return plans.map(p => {
    const covered = actual.filter(a => a.category === p.category).reduce((s, a) => s + overlap(a, p), 0);
    return { date, category: p.category, title: p.title, startMin: p.startMin, endMin: p.endMin, done: covered * 2 >= p.endMin - p.startMin };
  });
}

export interface WeekTime {
  weekStart: string;
  /** 已结束的天数 */
  days: number;
  rows: Array<{
    category: string;
    hours: number;
    reportedHours: number;
    budget: number | null;
    /** 计划段：完成 / 总数 */
    planDone: number;
    planTotal: number;
  }>;
  unrecordedHours: number;
  reportedDays: number;
  /** 实测睡眠（Watch）日均，有才给 */
  sleepMeasured: number | null;
  screen: { avgMin: number; pickups: number | null; social: number; top: Array<{ name: string; min: number }>; categories: Record<string, number> } | null;
}

const SOCIAL_KEYS = ['社交', '娱乐', '游戏', 'Social', 'Entertainment', 'Games'];
export const leisureScreenMin = (cats: Record<string, number>) =>
  Object.entries(cats).reduce((s, [k, v]) => s + (SOCIAL_KEYS.includes(k) ? v : 0), 0);

/**
 * 一周的时间账（周一起；只算已结束的日子）。
 * sleepByDate：Watch 实测睡眠小时（有的日子用它替换模板推定的睡眠）。
 */
export function weekTime(
  weekStart: string,
  today: string,
  rules: TimeRule[],
  blocks: TimeBlock[],
  screen: ScreenRecord[],
  sleepByDate: Record<string, number> = {}
): WeekTime {
  const lastDay = shift(weekStart, 6) < today ? shift(weekStart, 6) : shift(today, -1);
  const n = Math.max(0, daysBetween(weekStart, lastDay) + 1);
  const mins: Record<string, number> = {};
  const rep: Record<string, number> = {};
  let unrecorded = 0;
  let reportedDays = 0;
  const sleeps: number[] = [];
  const checks: PlanCheck[] = [];
  for (let i = 0; i < n; i++) {
    const d = shift(weekStart, i);
    const l = dayLedger(d, rules, blocks);
    if (l.hasActual) reportedDays++;
    unrecorded += l.unrecorded;
    for (const [c, v] of Object.entries(l.assumed)) mins[c] = (mins[c] || 0) + v;
    for (const [c, v] of Object.entries(l.reported)) {
      mins[c] = (mins[c] || 0) + v;
      rep[c] = (rep[c] || 0) + v;
    }
    if (sleepByDate[d] != null) {
      // 实测睡眠替换推定：差额记到「未记录」里，不凭空挪给别的类
      const est = (l.assumed['睡眠'] || 0) + (l.reported['睡眠'] || 0);
      const meas = Math.round(sleepByDate[d] * 60);
      mins['睡眠'] = (mins['睡眠'] || 0) - est + meas;
      unrecorded += est - meas;
      sleeps.push(sleepByDate[d]);
    }
    checks.push(...planChecks(d, rules, blocks));
  }
  const budgets = new Map(rules.filter(r => r.kind === 'budget').map(r => [r.category, r.hoursPerWeek]));
  const cats = CATEGORIES.filter(c => mins[c] || budgets.has(c) || checks.some(p => p.category === c));
  const wk = screen.find(s => s.period === 'week' && s.start === weekStart);
  const days = screen.filter(s => s.period === 'day' && s.start >= weekStart && s.start <= shift(weekStart, 6));
  let scr: WeekTime['screen'] = null;
  if (wk) scr = { avgMin: wk.avgMin, pickups: wk.pickups, social: leisureScreenMin(wk.categories), top: wk.apps.slice(0, 5), categories: wk.categories };
  else if (days.length) {
    const avg = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
    const merged: Record<string, number> = {};
    for (const d of days) for (const [k, v] of Object.entries(d.categories)) merged[k] = (merged[k] || 0) + v / days.length;
    scr = {
      avgMin: avg(days.map(d => d.avgMin)),
      pickups: days.some(d => d.pickups != null) ? avg(days.filter(d => d.pickups != null).map(d => d.pickups as number)) : null,
      social: Math.round(leisureScreenMin(merged)),
      top: [],
      categories: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, Math.round(v)])),
    };
  }
  return {
    weekStart,
    days: n,
    rows: cats.map(c => ({
      category: c,
      hours: r1((mins[c] || 0) / 60),
      reportedHours: r1((rep[c] || 0) / 60),
      budget: budgets.get(c) ?? null,
      planDone: checks.filter(p => p.category === c && p.done).length,
      planTotal: checks.filter(p => p.category === c).length,
    })),
    unrecordedHours: r1(unrecorded / 60),
    reportedDays,
    sleepMeasured: sleeps.length ? r1(sleeps.reduce((s, x) => s + x, 0) / sleeps.length) : null,
    screen: scr,
  };
}

/** 日程：从 from 起 n 天，每天的模板段 + 预先安排 + 实报，计划段带「做了没」。 */
export function schedule(from: string, n: number, today: string, rules: TimeRule[], blocks: TimeBlock[]) {
  return Array.from({ length: n }, (_, i) => {
    const date = shift(from, i);
    const checks = planChecks(date, rules, blocks);
    const actual = blocksFor(date, blocks, 'actual');
    const tmpl = templateFor(date, rules);
    const plans = blocksFor(date, blocks, 'plan');
    const segs = [...tmpl, ...plans, ...actual]
      .sort((a, b) => a.startMin - b.startMin || (a.origin === 'actual' ? 1 : -1))
      .map(s => ({
        ...s,
        start: hhmm(s.startMin),
        end: s.endMin >= 1440 ? '24:00' : hhmm(s.endMin),
        done:
          s.origin === 'template-plan' || s.origin === 'plan'
            ? checks.find(c => c.startMin === s.startMin && c.category === s.category)?.done ?? false
            : null,
      }));
    return { date, dow: dow(date), isToday: date === today, past: date < today, segs };
  });
}

/** 周复盘用：时间段的「下周重点 / 做得好」。 */
export function judgeTime(w: WeekTime): { focus: string[]; wins: string[] } {
  const focus: string[] = [];
  const wins: string[] = [];
  for (const r of w.rows) {
    if (r.budget == null) continue;
    // 有预算的类按实报算（主业/睡眠这类结构性时间本来就靠推定，不在这里对账）
    if (['主业', '睡眠', '杂务'].includes(r.category)) continue;
    const got = r.reportedHours;
    const plan = r.planTotal ? `，计划 ${r.planTotal} 段做了 ${r.planDone} 段` : '';
    if (got < r.budget * (w.days / 7) * 0.8) focus.push(`${r.category}：${got}/${r.budget} 小时${plan}`);
    else wins.push(`${r.category} ${got} 小时`);
  }
  if (w.screen && w.screen.social >= 120) focus.push(`屏幕时间：社交娱乐日均 ${Math.round(w.screen.social)} 分钟`);
  return { focus, wins };
}

/** "08:40" → 520；"24:00" → 1440 */
export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`时间格式应为 HH:MM：${s}`);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v > 1440 || Number(m[2]) >= 60) throw new Error(`时间不合法：${s}`);
  return v;
}

/**
 * 训练记录 → 时间段：网站上记了组的日子，若作息模板当天有「健康」计划段就按那一段算做了，
 * 否则按 12:00–12:45 记 45 分钟（计划课时）。这样训练只需在训练页记一次，时间页自动打勾。
 */
export function trainingBlocks(dates: string[], rules: TimeRule[]): TimeBlock[] {
  return [...new Set(dates)].map(date => {
    const plan = templateFor(date, rules).find(s => s.origin === 'template-plan' && s.category === '健康');
    return {
      date,
      startMin: plan ? plan.startMin : 720,
      endMin: plan ? plan.endMin : 765,
      category: '健康',
      title: '力量训练',
      kind: 'actual' as const,
      source: 'training',
    };
  });
}
