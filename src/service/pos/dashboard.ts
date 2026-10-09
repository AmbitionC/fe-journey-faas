import { Provide, Inject } from '@midwayjs/core';
import { PosFinanceService } from './finance';
import { PosContextService } from './context';
import { HealthBodyService } from '../health/body';
import { HealthMealService } from '../health/meal';
import { HealthActivityService } from '../health/activity';
import { HealthBudgetService } from '../health/budget';
import { HealthProfileService } from '../health/profile';
import { GrowthService } from '../growth';
import { computeGaps, daysBetween, freshness, movingAvg, todayCN } from './logic';

/** 单块失败不拖垮整页：返回 { error } 由前端显示「该块暂不可用」。 */
async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e: any) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}
const isErr = (v: any): v is { error: string } => v && typeof v === 'object' && 'error' in v && Object.keys(v).length === 1;

const shiftDate = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * 首页「此刻的我」聚合：健康（health 库）+ 财富（invest 库投影 + pos 手录）+
 * 事业（pos 收入 + 主站 growth）+ 上下文（目标/最近记录）+ 缺口 + 数据目录。
 * 每个数字都带 asOf 与事实类型，前端据此显示「来源 · 更新于 · 质量」。
 */
@Provide()
export class PosDashboardService {
  @Inject()
  finance: PosFinanceService;

  @Inject()
  context: PosContextService;

  @Inject()
  bodyService: HealthBodyService;

  @Inject()
  mealService: HealthMealService;

  @Inject()
  activityService: HealthActivityService;

  @Inject()
  budgetService: HealthBudgetService;

  @Inject()
  profileService: HealthProfileService;

  @Inject()
  growthService: GrowthService;

  async health(today = todayCN()) {
    const [trend, day, range, budget, activity, waist, profile] = await Promise.all([
      this.bodyService.trend(180),
      this.mealService.day(today),
      this.mealService.range(shiftDate(today, -13), today),
      this.budgetService.current(),
      this.activityService.list(14),
      this.context.latestMetric('health.waist').catch(() => null),
      this.profileService.get(),
    ]);
    const points = trend.map(b => ({ date: b.date, value: b.weightKg }));
    const ma = movingAvg(points, 7);
    const latest = trend[trend.length - 1] || null;
    const withFat = [...trend].reverse().find(b => b.bodyFatPct != null) || null;
    const firstFat = trend.find(b => b.bodyFatPct != null) || null;
    const ago30 = [...trend].reverse().find(b => daysBetween(b.date, today) >= 28) || null;
    const actDesc = [...activity].sort((a, b) => b.date.localeCompare(a.date));
    const lastActivity = actDesc.find(a => a.steps != null || a.activeKcal != null) || null;
    const lastSleep = actDesc.find(a => a.sleepHours != null) || null;
    const goals = profile.goals || [];
    const nextGoal =
      latest != null
        ? goals.find(g => g.metric === 'weight_kg' && g.value != null && latest.weightKg > g.value) || null
        : null;
    const kcalMap = new Map(range.map(r => [r.date, r]));
    const kcalSeries = Array.from({ length: 14 }, (_, i) => {
      const d = shiftDate(today, i - 13);
      const r = kcalMap.get(d);
      return { date: d, kcal: r ? r.totalKcal : null, budget: budget.intakeKcal };
    });
    const loggedDays = kcalSeries.filter(k => k.kcal != null && k.date !== today);
    return {
      weight: latest
        ? {
            value: latest.weightKg,
            asOf: latest.date,
            ma7: ma[ma.length - 1]?.value ?? null,
            delta30: ago30 ? Math.round((latest.weightKg - ago30.weightKg) * 100) / 100 : null,
            bmi: latest.bmi,
            factType: 'measured',
          }
        : null,
      bodyFat: withFat
        ? {
            value: withFat.bodyFatPct,
            asOf: withFat.date,
            baseline: firstFat && firstFat.date !== withFat.date ? { value: firstFat.bodyFatPct, date: firstFat.date } : null,
            visceral: withFat.visceralFatLevel,
            muscle: withFat.muscleMassKg,
            factType: 'measured',
          }
        : null,
      waist: waist ? { value: waist.value, asOf: waist.date } : null,
      today: {
        kcal: day.summary.totalKcal,
        budget: budget.intakeKcal,
        remaining: budget.intakeKcal - day.summary.totalKcal,
        proteinG: day.summary.proteinG,
        proteinTarget: budget.proteinG,
        meals: day.summary.mealsLogged,
        factType: 'estimated',
      },
      avgKcal7:
        loggedDays.length > 0
          ? Math.round(loggedDays.slice(-7).reduce((s, k) => s + (k.kcal || 0), 0) / Math.min(7, loggedDays.slice(-7).length))
          : null,
      activity: lastActivity
        ? {
            date: lastActivity.date,
            steps: lastActivity.steps,
            activeKcal: lastActivity.activeKcal,
            exerciseMinutes: lastActivity.exerciseMinutes,
            updatedAt: lastActivity.updatedAt,
          }
        : null,
      sleep: lastSleep ? { date: lastSleep.date, hours: lastSleep.sleepHours } : null,
      tdee: { value: budget.basis.tdee, source: budget.basis.tdeeSource },
      weightSeries: points.map((p, i) => ({ date: p.date, value: p.value, ma7: ma[i].value })),
      kcalSeries,
      nextGoal: nextGoal
        ? { ...nextGoal, remainingKg: latest ? Math.round((latest.weightKg - (nextGoal.value as number)) * 100) / 100 : null }
        : null,
    };
  }

  async career() {
    const [inc, side] = await Promise.all([
      this.finance.incomeSummary(),
      safe(() => this.growthService.overview()),
    ]);
    return {
      salary: inc.latestSalary,
      last12: inc.last12ByKindBasis,
      side: isErr(side)
        ? side
        : {
            month: side.month,
            revenue: side.monthRevenue,
            revenueBasis: '含自报付款（未全部核实）',
            verifiedPdf: side.monthManuallyVerifiedPdf,
            orders: side.monthOrderCount,
            cost: side.monthCost,
            net: side.netCashflow,
            newUsers: side.monthNewUsers,
            xhsFollowers: side.xhsFollowers,
            groupMembers: side.groupMembers,
          },
    };
  }

  async dashboard() {
    const today = todayCN();
    const [health, wealth, career, goals, facts, recent, planned, notesPending] = await Promise.all([
      safe(() => this.health(today)),
      safe(() => this.finance.wealth()),
      safe(() => this.career()),
      safe(() => this.context.goals()),
      safe(() => this.context.facts()),
      safe(() => this.context.timeline({ days: 14 })),
      safe(() => this.context.events({ status: 'planned' })),
      safe(() => this.context.notes({ days: 30 }).then(ns => ns.filter(n => n.aiStatus === 'pending').length)),
    ]);

    const h: any = isErr(health) ? null : health;
    const w: any = isErr(wealth) ? null : wealth;
    const c: any = isErr(career) ? null : career;
    const plannedList: any[] = isErr(planned) ? [] : (planned as any[]);
    const accounts: any[] = w?.accounts || [];

    const gaps = computeGaps({
      today,
      hasCashAccount: accounts.some(a => a.side === 'asset' && ['cash', 'bank', 'deposit'].includes(a.kind) && a.latest),
      hasLiability: accounts.some(a => a.side === 'liability'),
      salaryLatest: c?.salary ? { period: c.salary.period, basis: c.salary.basis } : null,
      overduePlanned: plannedList
        .filter(e => e.plannedDate && e.plannedDate < today)
        .map(e => ({ id: e.id, title: e.title, plannedDate: e.plannedDate })),
      investA: w?.investA?.latest?.asOf || null,
      investUs: w?.investUs?.latest?.asOf || null,
      usHoldingExpected: !w?.investUs?.latest && !accounts.some(a => a.currency === 'USD'),
      fxMissing: !!w && !w.fx?.USD && (!!w.investUs?.latest || accounts.some(a => a.currency === 'USD')),
      bodyFatAsOf: h?.bodyFat?.asOf || null,
      weightAsOf: h?.weight?.asOf || null,
      waistAsOf: h?.waist?.asOf || null,
      goalsCount: isErr(goals) ? 1 : (goals as any[]).length,
      factsCount: isErr(facts) ? 1 : (facts as any[]).length,
    });

    const src = (key: string, label: string, domain: string, asOf: string | null, detail: string) => ({
      key,
      label,
      domain,
      asOf,
      detail,
      ...freshness(key, asOf, today),
    });
    const latestBalance = accounts
      .map(a => a.latest?.asOf)
      .filter(Boolean)
      .sort()
      .pop() || null;
    const sources = [
      src('body_weight', '体重', 'health', h?.weight?.asOf || null, '体脂秤 · 健康页录入'),
      src('body_fat', '体脂/体成分', 'health', h?.bodyFat?.asOf || null, '体脂秤实测'),
      src('meals', '饮食', 'health', h && h.today.meals > 0 ? today : (h?.kcalSeries || []).filter((k: any) => k.kcal != null).map((k: any) => k.date).pop() || null, '拍照识别 · 估算 ±20%'),
      src('activity', 'Apple Watch 活动', 'health', h?.activity?.date || null, 'iOS 快捷指令推送'),
      src('waist', '腰围', 'health', h?.waist?.asOf || null, '每周手录'),
      src('invest_a', 'A 股账户', 'wealth', w?.investA?.latest?.asOf || null, w?.investA?.error ? `invest 库不可达：${w.investA.error}` : 'invest 系统 · 每日收盘重估'),
      src('invest_us', '美股账户', 'wealth', w?.investUs?.latest?.asOf || null, w?.investUs?.error ? `invest 库不可达：${w.investUs.error}` : 'invest 系统 · 美股快照（USD）'),
      src('fx', '美元汇率', 'wealth', w?.fx?.USD?.asOf || null, w?.fx?.USD ? `${w.fx.USD.source} ${w.fx.USD.rate}` : '未取到：可在财富页手录'),
      src('balance', '现金/负债手录', 'wealth', latestBalance, `${accounts.length} 个手录账户 · 建议每月核对`),
      src('income', '主业收入', 'career', c?.salary?.receivedDate || (c?.salary ? `${c.salary.period}-28` : null), '每月到账后手录'),
      src('growth', '副业经营', 'career', c && !isErr(c.side) ? today : null, c && isErr(c.side) ? `主站库不可达：${c.side.error}` : '主站订单/成本（实时）'),
    ];

    const wsum = w?.summary;
    return {
      today,
      health: isErr(health) ? health : h,
      wealth: w
        ? {
            netWorth: wsum.netWorth,
            totalAssets: wsum.totalAssets,
            totalLiabilities: wsum.totalLiabilities,
            investable: wsum.investable,
            liquidCash: wsum.liquidCash,
            approximate: wsum.approximate,
            partial: wsum.partial,
            hasLiabilityRecord: wsum.hasLiabilityRecord,
            missingParts: wsum.missingParts,
            staleParts: wsum.staleParts,
            lines: wsum.lines,
            fx: w.fx,
            aShare: w.investA.latest,
            aTop: w.investA.top,
            usShare: w.investUs.latest,
            series: w.series,
            aSeries: (w.investA.series || []).slice(-250),
          }
        : wealth,
      career: career,
      life: {
        goals: isErr(goals) ? [] : goals,
        planned: plannedList.slice(0, 5),
        recent: isErr(recent) ? [] : (recent as any[]).slice(0, 8),
        notesPending: isErr(notesPending) ? 0 : notesPending,
      },
      gaps,
      sources,
    };
  }
}
