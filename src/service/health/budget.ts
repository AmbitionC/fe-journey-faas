import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from './db';
import { HealthProfileService } from './profile';
import { HealthBodyService } from './body';

export interface DailyBudget {
  /** 当日热量预算（kcal），已扣除缺口 */
  intakeKcal: number;
  /** 蛋白质目标（g）与建议区间 */
  proteinG: number;
  proteinRange: [number, number];
  carbsG: number;
  fatG: number;
  /** 计算依据 */
  basis: {
    bmr: number;
    bmrMifflin: number;
    bmrKatch: number | null;
    tdee: number;
    tdeeSource: 'measured' | 'estimated';
    tdeeMeasuredDays: number;
    deficitKcal: number;
    weightKg: number | null;
    bodyFatPct: number | null;
    activityFactor: number;
  };
}

/**
 * 热量/宏量预算引擎。
 * - BMR：Mifflin-St Jeor；有体脂率时再算 Katch-McArdle 取两者均值。
 * - TDEE：近 14 天有 Apple Watch 实测（静息+活动能量）≥3 天 → 用实测均值；
 *   否则 BMR × 活动系数。拿到实测后预算自动从「估算」升级为「实测−缺口」。
 * - 摄入 = TDEE − 缺口，下限保护 max(1500, BMR×0.9)。
 */
@Provide()
export class HealthBudgetService {
  @Inject()
  db: HealthDbService;

  @Inject()
  profileService: HealthProfileService;

  @Inject()
  bodyService: HealthBodyService;

  async current(): Promise<DailyBudget> {
    const profile = await this.profileService.get();
    const body = await this.bodyService.latest();

    const weight = body?.weightKg ?? null;
    const bodyFatPct = body?.bodyFatPct ?? null;
    const age = new Date().getFullYear() - profile.birthYear;

    // BMR
    const w = weight ?? profile.goalWeightKg ?? 75;
    const sexConst = profile.sex === 'female' ? -161 : 5;
    const bmrMifflin = Math.round(
      10 * w + 6.25 * profile.heightCm - 5 * age + sexConst
    );
    let bmrKatch: number | null = null;
    if (weight != null && bodyFatPct != null) {
      const lbm = weight * (1 - bodyFatPct / 100);
      bmrKatch = Math.round(370 + 21.6 * lbm);
    }
    const bmr = bmrKatch ? Math.round((bmrMifflin + bmrKatch) / 2) : bmrMifflin;

    // TDEE：优先近 14 天实测（静息+活动能量都有的天数 ≥ 3）。
    // 排除「今天」：快捷指令白天会多次推送当天的不完整数据（盘中值），
    // 混进均值会把 TDEE 拉低、预算失真——只统计已经完整结束的日子。
    const todayCN = new Date(Date.now() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const rows = await this.db.q<{ total: number }>(
      `SELECT (resting_kcal + active_kcal) AS total FROM activity_daily
       WHERE record_date >= DATE_SUB(?, INTERVAL 14 DAY) AND record_date < ?
         AND resting_kcal IS NOT NULL AND active_kcal IS NOT NULL AND resting_kcal > 0`,
      [todayCN, todayCN]
    );
    let tdee: number;
    let tdeeSource: 'measured' | 'estimated';
    if (rows.length >= 3) {
      tdee = Math.round(
        rows.reduce((s, r) => s + Number(r.total), 0) / rows.length
      );
      tdeeSource = 'measured';
    } else {
      tdee = Math.round(bmr * profile.activityFactor);
      tdeeSource = 'estimated';
    }

    // 摄入预算（下限保护，避免过度节食）
    const floor = Math.max(1500, Math.round(bmr * 0.9));
    const intakeKcal = Math.max(floor, tdee - profile.deficitKcal);

    // 宏量：蛋白按目标体重 × 系数；脂肪 27.5% 热量；碳水吃剩余
    const goalW = profile.goalWeightKg ?? w;
    const proteinG = Math.round(goalW * profile.proteinPerKg);
    const proteinRange: [number, number] = [
      Math.round(goalW * 1.6),
      Math.round(goalW * 2.0),
    ];
    const fatG = Math.round((intakeKcal * 0.275) / 9);
    const carbsG = Math.max(
      0,
      Math.round((intakeKcal - proteinG * 4 - fatG * 9) / 4)
    );

    return {
      intakeKcal,
      proteinG,
      proteinRange,
      carbsG,
      fatG,
      basis: {
        bmr,
        bmrMifflin,
        bmrKatch,
        tdee,
        tdeeSource,
        tdeeMeasuredDays: rows.length,
        deficitKcal: profile.deficitKcal,
        weightKg: weight,
        bodyFatPct,
        activityFactor: profile.activityFactor,
      },
    };
  }
}
