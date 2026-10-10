import { daysBetween, movingAvg, muscleTrend, STRENGTH_RE } from './logic';
import { AlertInput, deficitDays, deficitHigh, intakeFloor, maAt, shift } from './alerts';

/**
 * 健康周复盘（纯函数，无 IO）。一周＝周一到周日（北京时间）。
 * 只统计已经结束的日子；热量相关只算记全的日子（同预警口径，见 alerts.ts）。
 * 结论（下周重点 / 做得好）全部由规则从数字推出，不写数据之外的判断。
 */

export interface ReviewInput {
  today: string;
  budget: AlertInput['budget'];
  meals: AlertInput['meals'];
  activity: Array<
    AlertInput['activity'][number] & { steps?: number | null; exerciseMinutes?: number | null }
  >;
  body: Array<{ date: string; weightKg: number; bodyFatPct?: number | null; muscleMassKg: number | null }>;
  /** 下一阶段体重目标（kg），没有就 null */
  goalKg?: number | null;
}

export interface WeekStats {
  weekStart: string;
  weekEnd: string;
  /** 本周已结束的天数（进行中的周 < 7） */
  days: number;
  kcal: {
    completeDays: number;
    mealDays: number;
    avgIntake: number | null;
    avgBurn: number | null;
    avgDeficit: number | null;
    totalDeficit: number | null;
    surplusDays: number;
    lowDays: number;
  };
  protein: { avg: number | null; hitDays: number; target: number };
  body: {
    weighIns: number;
    maEnd: number | null;
    weightDelta: number | null;
    bodyFat: number | null;
    bodyFatDelta: number | null;
    muscle: number | null;
    muscleDelta: number | null;
    /** 记账推出的理论减重（kg）：记全天平均缺口 × 天数 / 7700 */
    expectedLossKg: number | null;
  };
  sleep: { avg: number | null; nights: number; shortNights: number };
  train: { strengthDays: number; workoutDays: number; avgSteps: number | null; avgExerciseMin: number | null; watchDays: number };
}

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  partial: boolean;
  cur: WeekStats;
  prev: WeekStats | null;
  focus: string[];
  wins: string[];
  goal: { targetKg: number; remainingKg: number; weeksAtPace: number | null } | null;
}

const KCAL_PER_KG = 7700;
const r1 = (x: number) => Math.round(x * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const rnd = (x: number | null) => (x == null ? null : Math.round(x));

/** 某日所在周的周一。 */
export function weekStartOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=周日
  return shift(date, -((dow + 6) % 7));
}

export function weekStats(input: ReviewInput, weekStart: string): WeekStats {
  const weekEnd = shift(weekStart, 6);
  const lastDay = weekEnd < input.today ? weekEnd : shift(input.today, -1);
  const n = Math.max(0, daysBetween(weekStart, lastDay) + 1);
  const inWeek = (d: string) => d >= weekStart && d <= lastDay;

  const dd = n ? deficitDays(input, n, lastDay) : [];
  const done = dd.filter(d => d.complete);
  const floor = intakeFloor(input.budget.bmr);
  const avgDef = avg(done.map(d => d.deficit as number));

  const body = [...input.body].sort((a, b) => a.date.localeCompare(b.date));
  const ma = movingAvg(
    body.map(b => ({ date: b.date, value: b.weightKg })),
    7
  );
  const end = n ? maAt(ma, lastDay, 3) : null;
  const start = maAt(ma, shift(weekStart, -1), 4);
  const weightDelta = end && start && end.date > start.date ? r1(end.value - start.value) : null;
  const latestIn = (k: 'bodyFatPct' | 'muscleMassKg') => [...body].reverse().find(b => inWeek(b.date) && b[k] != null) || null;
  const beforeWeek = (k: 'bodyFatPct' | 'muscleMassKg') =>
    [...body].reverse().find(b => b.date < weekStart && b[k] != null) || null;
  const fat = latestIn('bodyFatPct');
  const fat0 = beforeWeek('bodyFatPct');
  const mus = latestIn('muscleMassKg');
  const mus0 = beforeWeek('muscleMassKg');

  const acts = input.activity.filter(a => inWeek(a.date));
  const sleeps = acts.filter(a => a.sleepHours != null && a.sleepHours > 0).map(a => a.sleepHours as number);
  const steps = acts.filter(a => a.steps != null && (a.steps as number) > 0).map(a => a.steps as number);
  const exMin = acts.filter(a => a.exerciseMinutes != null).map(a => a.exerciseMinutes as number);

  return {
    weekStart,
    weekEnd,
    days: n,
    kcal: {
      completeDays: done.length,
      mealDays: dd.filter(d => d.meals > 0).length,
      avgIntake: rnd(avg(done.map(d => d.intake as number))),
      avgBurn: rnd(avg(done.map(d => d.burn))),
      avgDeficit: rnd(avgDef),
      totalDeficit: done.length ? done.reduce((s, d) => s + (d.deficit as number), 0) : null,
      surplusDays: done.filter(d => (d.deficit as number) < 0).length,
      lowDays: done.filter(d => (d.intake as number) < floor).length,
    },
    protein: {
      avg: rnd(avg(done.map(d => d.proteinG ?? 0))),
      hitDays: done.filter(d => (d.proteinG ?? 0) >= input.budget.protein * 0.9).length,
      target: input.budget.protein,
    },
    body: {
      weighIns: body.filter(b => inWeek(b.date)).length,
      maEnd: end ? end.value : null,
      weightDelta,
      bodyFat: fat ? (fat.bodyFatPct as number) : null,
      bodyFatDelta: fat && fat0 ? r1((fat.bodyFatPct as number) - (fat0.bodyFatPct as number)) : null,
      muscle: mus ? (mus.muscleMassKg as number) : null,
      muscleDelta: mus && mus0 ? r1((mus.muscleMassKg as number) - (mus0.muscleMassKg as number)) : null,
      expectedLossKg: avgDef != null && done.length >= 4 ? r1((avgDef * n) / KCAL_PER_KG) : null,
    },
    sleep: {
      avg: sleeps.length ? r1(avg(sleeps) as number) : null,
      nights: sleeps.length,
      shortNights: sleeps.filter(h => h < 7).length,
    },
    train: {
      strengthDays: acts.filter(a => (a.workouts || []).some(w => STRENGTH_RE.test(String(w.type || '')))).length,
      workoutDays: acts.filter(a => (a.workouts || []).length > 0).length,
      avgSteps: rnd(avg(steps)),
      avgExerciseMin: rnd(avg(exMin)),
      watchDays: acts.filter(a => a.activeKcal != null || a.steps != null || a.sleepHours != null).length,
    },
  };
}

const sgn = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toLocaleString('en-US')}`;

/** 下周重点（最多 3 条，按优先级）与做得好的地方（最多 2 条）。 */
export function judge(cur: WeekStats, input: ReviewInput): { focus: string[]; wins: string[] } {
  const focus: string[] = [];
  const wins: string[] = [];
  const t = input.budget.deficitTarget;
  const k = cur.kcal;

  if (k.completeDays < Math.min(5, cur.days))
    focus.push(`先把饮食记全：${cur.days} 天里只有 ${k.completeDays} 天记全，热量差算不准`);
  const lastBody = [...input.body].filter(b => b.date <= cur.weekEnd);
  const m = muscleTrend(lastBody);
  if (m?.loss) focus.push(`掉肌 ${sgn(m.delta as number)} kg（${m.days} 天）：缺口收一收，蛋白和力量训练补上`);
  if (k.avgDeficit != null && k.completeDays >= 3) {
    if (k.avgDeficit < t * 0.6) focus.push(`热量缺口不够：日均 ${sgn(k.avgDeficit)} kcal，目标 ${t}`);
    else if (k.avgDeficit > deficitHigh(t)) focus.push(`热量缺口偏大：日均 ${k.avgDeficit} kcal，目标 ${t}，容易掉肌`);
    else wins.push(`热量缺口达标：日均 ${sgn(k.avgDeficit)} kcal`);
  }
  if (k.completeDays >= 3) {
    if (cur.protein.hitDays < Math.ceil(k.completeDays * 0.6))
      focus.push(`蛋白：${k.completeDays} 天里 ${cur.protein.hitDays} 天达标，日均 ${cur.protein.avg} g（目标 ${cur.protein.target} g）`);
    else wins.push(`蛋白 ${cur.protein.hitDays} 天达标`);
  }
  if (cur.sleep.nights >= 3) {
    if ((cur.sleep.avg as number) < 7) focus.push(`睡眠：日均 ${cur.sleep.avg} 小时，${cur.sleep.shortNights} 晚不到 7 小时`);
    else wins.push(`睡眠日均 ${cur.sleep.avg} 小时`);
  }
  if (cur.train.watchDays >= 3) {
    if (cur.train.strengthDays < 2) focus.push(`力量训练：本周 ${cur.train.strengthDays} 次，至少 2 次`);
    else wins.push(`力量训练 ${cur.train.strengthDays} 次`);
  }
  if (cur.body.weighIns === 0) focus.push('这周没称重，至少称一次（带体脂）');
  else if (cur.body.weightDelta != null && cur.body.weightDelta < 0 && !m?.loss)
    wins.push(`体重 ${sgn(cur.body.weightDelta)} kg`);
  const e = cur.body.expectedLossKg;
  if (e != null && cur.body.weightDelta != null && e - -cur.body.weightDelta >= 0.7)
    focus.push(`热量账对不上：按记账应减 ${e} kg，实际 ${sgn(cur.body.weightDelta)} kg，查漏记`);
  if (cur.train.watchDays === 0) focus.push('Watch 一周没同步，检查快捷指令');

  return { focus: focus.slice(0, 3), wins: wins.slice(0, 2) };
}

export function weeklyReview(input: ReviewInput, weekStart: string): WeeklyReview {
  const cur = weekStats(input, weekStart);
  const prevStart = shift(weekStart, -7);
  const prev = weekStats(input, prevStart);
  const hasPrev = prev.kcal.mealDays > 0 || prev.body.weighIns > 0 || prev.train.watchDays > 0;
  const { focus, wins } = judge(cur, input);
  let goal: WeeklyReview['goal'] = null;
  if (input.goalKg != null && cur.body.maEnd != null && cur.body.maEnd > input.goalKg) {
    const remaining = r1(cur.body.maEnd - input.goalKg);
    const pace = cur.body.weightDelta != null && cur.body.weightDelta < 0 ? -cur.body.weightDelta : null;
    goal = { targetKg: input.goalKg, remainingKg: remaining, weeksAtPace: pace ? Math.ceil(remaining / pace) : null };
  }
  return {
    weekStart,
    weekEnd: cur.weekEnd,
    partial: cur.days < 7,
    cur,
    prev: hasPrev ? prev : null,
    focus: focus.length ? focus : ['保持现在的节奏'],
    wins,
    goal,
  };
}

const num = (x: number | null, unit = '') => (x == null ? '—' : `${x.toLocaleString('en-US')}${unit}`);
const sgnU = (x: number | null, unit = '') => (x == null ? '—' : `${sgn(x)}${unit}`);

/** Issue 评论正文（人读要点；完整数字在网站周复盘页）。 */
export function renderWeekly(r: WeeklyReview): string {
  const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  const c = r.cur;
  const p = r.prev;
  const row = (label: string, a: string, b: string) => `| ${label} | ${a} | ${b} |`;
  const lines = [
    `### 📊 ${md(r.weekStart)}–${md(r.weekEnd)} 周复盘`,
    '',
    '**下周重点**',
    ...r.focus.map((f, i) => `${i + 1}. ${f}`),
  ];
  if (r.wins.length) lines.push('', `**做得好**：${r.wins.join('；')}`);
  lines.push(
    '',
    '| | 本周 | 上周 |',
    '|---|---|---|',
    row('热量缺口（日均）', sgnU(c.kcal.avgDeficit, ' kcal'), sgnU(p?.kcal.avgDeficit ?? null, ' kcal')),
    row('记全天数', `${c.kcal.completeDays}/${c.days}`, p ? `${p.kcal.completeDays}/${p.days}` : '—'),
    row('平均摄入', num(c.kcal.avgIntake, ' kcal'), num(p?.kcal.avgIntake ?? null, ' kcal')),
    row('蛋白达标', `${c.protein.hitDays} 天`, p ? `${p.protein.hitDays} 天` : '—'),
    row('体重（7 日均变化）', sgnU(c.body.weightDelta, ' kg'), sgnU(p?.body.weightDelta ?? null, ' kg')),
    row('睡眠（日均）', num(c.sleep.avg, ' h'), num(p?.sleep.avg ?? null, ' h')),
    row('力量训练', `${c.train.strengthDays} 次`, p ? `${p.train.strengthDays} 次` : '—'),
    row('日均步数', num(c.train.avgSteps), num(p?.train.avgSteps ?? null))
  );
  const tail: string[] = [];
  if (c.body.expectedLossKg != null)
    tail.push(`记账理论减重 ${c.body.expectedLossKg} kg · 实际 ${sgnU(c.body.weightDelta, ' kg')}`);
  if (c.body.bodyFat != null) tail.push(`体脂 ${c.body.bodyFat}%（${sgnU(c.body.bodyFatDelta, ' pt')}）`);
  if (c.body.muscle != null) tail.push(`肌肉 ${c.body.muscle} kg（${sgnU(c.body.muscleDelta, ' kg')}）`);
  if (r.goal)
    tail.push(
      `距 ${r.goal.targetKg} kg 还差 ${r.goal.remainingKg} kg${r.goal.weeksAtPace ? `，按本周速度约 ${r.goal.weeksAtPace} 周` : ''}`
    );
  if (tail.length) lines.push('', tail.join('　|　'));
  return lines.join('\n');
}
