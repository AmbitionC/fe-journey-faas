import { daysBetween, movingAvg, muscleTrend, sleepSummary, strengthDays } from './logic';

/**
 * 健康 / 热量差预警（纯函数，无 IO）。
 *
 * 热量缺口 = 当日消耗 − 摄入（正数＝吃得比消耗少）。
 * - 当日消耗：Watch 当天静息+活动能量且已是「收盘值」（最后一次同步发生在第二天及以后）才用当天实测，
 *   否则用预算引擎的 TDEE（近 14 天实测均值或估算）——快捷指令白天推的盘中值会把消耗算少。
 * - 记全：当天 ≥2 餐且 ≥800 kcal 才算，没记全的日子不进均值（不然缺口虚高）。
 */

export type AlertLevel = 'red' | 'warn';
export type AlertDomain = 'kcal' | 'body' | 'sleep' | 'train' | 'data';

export interface PosAlert {
  /** 去重键：每天一次的带日期（kcal-surplus:2026-10-09），持续状态类不带 */
  key: string;
  level: AlertLevel;
  domain: AlertDomain;
  title: string;
  detail?: string;
}

export interface DeficitDay {
  date: string;
  intake: number | null;
  burn: number;
  burnSource: 'day' | 'avg';
  deficit: number | null;
  meals: number;
  complete: boolean;
  proteinG: number | null;
}

export interface AlertInput {
  today: string;
  /** 北京时间小时（0-23）：19 点后才评估「今天」类预警 */
  hour: number;
  budget: { intake: number; protein: number; tdee: number; deficitTarget: number; bmr: number };
  /** 近 14 天每日饮食汇总（含今天，可缺天） */
  meals: Array<{ date: string; kcal: number; proteinG: number; meals: number }>;
  activity: Array<{
    date: string;
    activeKcal: number | null;
    restingKcal: number | null;
    sleepHours: number | null;
    workouts: Array<{ type: string }>;
    updatedAt: string | null;
  }>;
  body: Array<{ date: string; weightKg: number; muscleMassKg: number | null }>;
}

const KCAL_PER_KG = 7700;
export const shift = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const cnDate = (iso: string) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const r1 = (x: number) => Math.round(x * 10) / 10;
const sgn = (x: number, unit = '') => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x)}${unit}`;

/** 吃得太少的下限：同预算引擎 max(1500, BMR×0.9)。 */
export const intakeFloor = (bmr: number) => Math.max(1500, Math.round(bmr * 0.9));

/** 截至 end（默认今天，含）的近 days 天每日热量缺口，升序。 */
export function deficitDays(
  input: Pick<AlertInput, 'today' | 'budget' | 'meals' | 'activity'>,
  days = 14,
  end = input.today
): DeficitDay[] {
  const mealMap = new Map(input.meals.map(m => [m.date, m]));
  const actMap = new Map(input.activity.map(a => [a.date, a]));
  return Array.from({ length: days }, (_, i) => {
    const date = shift(end, i - days + 1);
    const m = mealMap.get(date);
    const a = actMap.get(date);
    const final = !!a?.updatedAt && cnDate(a.updatedAt) > date;
    const dayBurn =
      final && a!.activeKcal != null && a!.restingKcal != null && a!.restingKcal > 0
        ? Math.round(a!.activeKcal + a!.restingKcal)
        : null;
    const burn = dayBurn ?? input.budget.tdee;
    const complete = !!m && m.meals >= 2 && m.kcal >= 800;
    return {
      date,
      intake: m ? Math.round(m.kcal) : null,
      burn,
      burnSource: dayBurn != null ? 'day' : 'avg',
      deficit: m ? burn - Math.round(m.kcal) : null,
      meals: m?.meals ?? 0,
      complete,
      proteinG: m ? m.proteinG : null,
    };
  });
}

/** 近 7 个已结束的日子里记全的那些天的平均缺口。 */
export function deficitSummary(input: AlertInput) {
  const days = deficitDays(input, 14);
  const ended = days.filter(d => d.date < input.today);
  const last7 = ended.slice(-7).filter(d => d.complete);
  const avg7 = last7.length ? Math.round(last7.reduce((s, d) => s + (d.deficit as number), 0) / last7.length) : null;
  const yesterday = ended[ended.length - 1] || null;
  return { days, yesterday, avg7, completeDays7: last7.length, target: input.budget.deficitTarget };
}

/** 体重 7 日均线在某日（含）之前、且不早于 maxLag 天的最后一个点。 */
export function maAt(ma: Array<{ date: string; value: number }>, date: string, maxLag: number) {
  const p = [...ma].reverse().find(x => x.date <= date);
  return p && daysBetween(p.date, date) <= maxLag ? p : null;
}

export function healthAlerts(input: AlertInput): PosAlert[] {
  const out: PosAlert[] = [];
  const { today, hour, budget } = input;
  const yday = shift(today, -1);
  const sum = deficitSummary(input);
  const floor = intakeFloor(budget.bmr);
  const todayRow = sum.days[sum.days.length - 1];
  const y = sum.yesterday;

  // ── 热量差：昨天 ──
  if (y && y.complete) {
    if ((y.deficit as number) < 0)
      out.push({
        key: `kcal-surplus:${y.date}`,
        level: 'warn',
        domain: 'kcal',
        title: `昨天热量盈余 ${sgn(-(y.deficit as number))} kcal`,
        detail: `摄入 ${y.intake} · 消耗 ${y.burn}`,
      });
    else if ((y.intake as number) < floor)
      out.push({
        key: `kcal-low:${y.date}`,
        level: 'warn',
        domain: 'kcal',
        title: `昨天只吃了 ${y.intake} kcal`,
        detail: `低于下限 ${floor}，容易掉肌`,
      });
  } else if (y && y.date === yday) {
    out.push({
      key: `meal-partial:${y.date}`,
      level: 'warn',
      domain: 'data',
      title: y.meals ? `昨天只记了 ${y.meals} 餐` : '昨天没记餐',
      detail: '热量差算不出来',
    });
  }

  // ── 热量差：近 7 天 ──
  if (sum.avg7 != null && sum.completeDays7 >= 4) {
    if (sum.avg7 < budget.deficitTarget * 0.4)
      out.push({
        key: 'kcal-week-small',
        level: 'warn',
        domain: 'kcal',
        title: `近 7 天平均缺口 ${sgn(sum.avg7)} kcal`,
        detail: `目标 ${budget.deficitTarget}`,
      });
    else if (sum.avg7 > budget.deficitTarget + 500)
      out.push({
        key: 'kcal-week-big',
        level: 'warn',
        domain: 'kcal',
        title: `近 7 天平均缺口 ${sum.avg7} kcal，偏大`,
        detail: `目标 ${budget.deficitTarget}，缺口太大容易掉肌`,
      });
  }

  // ── 蛋白：近 7 天 ──
  const ended7 = sum.days.filter(d => d.date < today).slice(-7).filter(d => d.complete);
  const lowProtein = ended7.filter(d => (d.proteinG ?? 0) < budget.protein * 0.8).length;
  if (ended7.length >= 4 && lowProtein >= Math.max(4, Math.ceil(ended7.length * 0.7)))
    out.push({
      key: 'protein-week',
      level: 'warn',
      domain: 'kcal',
      title: `近 7 天有 ${lowProtein} 天蛋白不足`,
      detail: `目标 ${budget.protein} g`,
    });

  // ── 今天（晚上才评估） ──
  if (hour >= 19) {
    if (!todayRow.intake)
      out.push({ key: `meal-none:${today}`, level: 'warn', domain: 'data', title: '今天还没记餐' });
    else {
      const intake = todayRow.intake;
      if (intake > budget.tdee)
        out.push({
          key: `kcal-today-surplus:${today}`,
          level: 'warn',
          domain: 'kcal',
          title: `今天已热量盈余 ${sgn(intake - budget.tdee)} kcal`,
          detail: `摄入 ${intake} · 消耗约 ${budget.tdee}`,
        });
      else if (intake > budget.intake + 100)
        out.push({
          key: `kcal-today-over:${today}`,
          level: 'warn',
          domain: 'kcal',
          title: `今天超预算 ${intake - budget.intake} kcal`,
          detail: `缺口还剩 ${budget.tdee - intake}`,
        });
      const gap = Math.round(budget.protein - (todayRow.proteinG ?? 0));
      if ((todayRow.proteinG ?? 0) < budget.protein * 0.7)
        out.push({ key: `protein-today:${today}`, level: 'warn', domain: 'kcal', title: `今天蛋白还差 ${gap} g` });
    }
  }

  // ── 体成分 ──
  const body = [...input.body].sort((a, b) => a.date.localeCompare(b.date));
  const m = muscleTrend(body);
  if (m?.loss)
    out.push({
      key: 'muscle-loss',
      level: 'red',
      domain: 'body',
      title: `掉肌 ${sgn(m.delta as number, ' kg')}（${m.days} 天）`,
      detail: `同期体重 ${sgn(m.deltaWeight as number, ' kg')}`,
    });

  const ma = movingAvg(
    body.map(b => ({ date: b.date, value: b.weightKg })),
    7
  );
  const last = ma[ma.length - 1];
  if (last) {
    const ref = maAt(ma, shift(last.date, -14), 7);
    if (ref) {
      const span = daysBetween(ref.date, last.date);
      const change = r1(last.value - ref.value);
      const perWeek = r1((-change / span) * 7);
      if (perWeek > last.value * 0.01)
        out.push({
          key: 'weight-fast',
          level: 'warn',
          domain: 'body',
          title: `减重偏快：每周 −${perWeek} kg`,
          detail: `超过体重的 1%，容易掉肌`,
        });
      else if (change >= 1)
        out.push({
          key: 'weight-rebound',
          level: 'warn',
          domain: 'body',
          title: `体重反弹 ${sgn(change, ' kg')}（${span} 天）`,
        });
    }
  }

  // 热量账 vs 体重：14 天记账应减的 vs 实际减的
  const win = sum.days.filter(d => d.date < today && d.date >= shift(today, -14));
  const done = win.filter(d => d.complete);
  const end = maAt(ma, yday, 3);
  const start = maAt(ma, shift(today, -15), 4);
  if (done.length >= 10 && end && start && daysBetween(start.date, end.date) >= 10) {
    const span = daysBetween(start.date, end.date);
    const avgDef = done.reduce((s, d) => s + (d.deficit as number), 0) / done.length;
    const expected = r1((avgDef * span) / KCAL_PER_KG);
    const actual = r1(start.value - end.value);
    if (expected - actual >= 1)
      out.push({
        key: 'kcal-calibration',
        level: 'warn',
        domain: 'kcal',
        title: `按记账应减 ${expected} kg，实际 ${actual >= 0 ? `减 ${actual}` : `涨 ${-actual}`} kg`,
        detail: '可能漏记，或消耗被高估',
      });
  }

  // ── 睡眠 ──
  const sl = sleepSummary(input.activity, today);
  const nights = input.activity
    .filter(a => a.sleepHours != null && a.sleepHours > 0 && daysBetween(a.date, today) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-3);
  if (nights.length === 3 && daysBetween(nights[0].date, today) <= 3 && nights.every(n => (n.sleepHours as number) < 6))
    out.push({ key: 'sleep-short3', level: 'red', domain: 'sleep', title: '连续 3 晚睡不到 6 小时' });
  else if (sl && sl.nights >= 4 && sl.avg7 < 6.5)
    out.push({ key: 'sleep-low', level: 'warn', domain: 'sleep', title: `近 7 天平均睡眠 ${sl.avg7} 小时` });

  // ── 力量训练 ──
  if (strengthDays(input.activity, today) === 0)
    out.push({ key: 'strength-none', level: 'warn', domain: 'train', title: '近 7 天没有力量训练' });

  // ── 数据断了（不然上面的预警全部失效） ──
  const lastAct = [...input.activity]
    .filter(a => a.activeKcal != null || a.sleepHours != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .pop();
  const actAge = lastAct ? daysBetween(lastAct.date, today) : null;
  if (actAge == null || actAge >= 3)
    out.push({
      key: 'watch-stale',
      level: 'warn',
      domain: 'data',
      title: actAge == null ? 'Watch 数据没有同步' : `Watch 已 ${actAge} 天没同步`,
    });
  const lastBody = body[body.length - 1];
  const bodyAge = lastBody ? daysBetween(lastBody.date, today) : null;
  if (bodyAge == null || bodyAge > 7)
    out.push({
      key: 'weigh-stale',
      level: 'warn',
      domain: 'data',
      title: bodyAge == null ? '还没有称重记录' : `已 ${bodyAge} 天没称重`,
    });

  const rank = { red: 0, warn: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * 推送去重：持续状态类预警只在「新出现 / 升级 / 距上次推送满 7 天」时推；
 * 带日期的键天然每天只推一次。返回要推送的预警。
 */
export function alertsToPush(
  alerts: PosAlert[],
  state: Map<string, { level: AlertLevel; active: boolean; lastPushed: string | null }>,
  today: string
): PosAlert[] {
  return alerts.filter(a => {
    const s = state.get(a.key);
    if (!s || !s.active || !s.lastPushed) return true;
    if (s.level === 'warn' && a.level === 'red') return true;
    return daysBetween(s.lastPushed.slice(0, 10), today) >= 7;
  });
}
