import { Provide, Inject } from '@midwayjs/core';
import { PosDbService } from './db';
import { HealthBodyService } from '../health/body';
import { HealthMealService } from '../health/meal';
import { HealthActivityService } from '../health/activity';
import { HealthBudgetService } from '../health/budget';
import { HealthProfileService } from '../health/profile';
import { nowCN, todayCN } from './logic';
import { shift } from './alerts';
import { ReviewInput, WeeklyReview, renderWeekly, weekStartOf, weeklyReview } from './review';
import { postIssueComment } from './alertPush';
import { HealthTrainingService } from '../health/training/service';
import { PLAN } from '../health/training/plan';
import { withTrainingDays } from './logic';
import { ActivityRecord } from '../health/activity';

/**
 * 健康周复盘：每周一（北京 09:00，pos-alert-cron 触发）对上一周出一份，
 * 存 pos_weekly_review，并在 invest-model Issue（POS_REVIEW_ISSUE，默认 286「📊 健康周复盘」）追评 → 邮件。
 * 同一周只推一次（pushed_at）；重算会覆盖存档但不重复推送。
 */
@Provide()
export class PosReviewService {
  @Inject()
  db: PosDbService;

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
  trainingService: HealthTrainingService;

  private async input(today: string): Promise<ReviewInput> {
    const [budget, range, watch, body, profile, plan, sets] = await Promise.all([
      this.budgetService.current(),
      this.mealService.range(shift(today, -21), today),
      this.activityService.list(25),
      this.bodyService.trend(180),
      this.profileService.get(),
      this.trainingService.plan().catch(() => null),
      this.trainingService.setsBetween(shift(today, -120), today).catch(() => []),
    ]);
    const blank = (date: string): ActivityRecord => ({
      date,
      steps: null,
      activeKcal: null,
      restingKcal: null,
      exerciseMinutes: null,
      standHours: null,
      workouts: [],
      sleepHours: null,
      weightKg: null,
      source: 'training-log',
      updatedAt: null,
    });
    const activity = withTrainingDays(watch, [...new Set(sets.map(x => x.date))], blank);
    const latest = body[body.length - 1];
    const goal =
      latest != null
        ? (profile.goals || []).find(g => g.metric === 'weight_kg' && g.value != null && latest.weightKg > g.value)
        : null;
    return {
      today,
      budget: {
        intake: budget.intakeKcal,
        protein: budget.proteinG,
        tdee: budget.basis.tdee,
        deficitTarget: budget.basis.deficitKcal,
        bmr: budget.basis.bmr,
      },
      meals: range.map(r => ({ date: r.date, kcal: r.totalKcal, proteinG: r.proteinG, meals: r.mealsLogged })),
      activity,
      body,
      goalKg: goal?.value ?? null,
      training: { planned: plan ? PLAN.perWeek : null, sets },
    };
  }

  /** 某周（默认本周，进行中）的复盘，实时计算、不存档。 */
  async live(weekStart?: string): Promise<WeeklyReview> {
    const today = todayCN();
    return weeklyReview(await this.input(today), weekStart || weekStartOf(today));
  }

  /** 本周至今（实时）+ 已存档的历史周（新→旧）。 */
  async list(limit = 12): Promise<{ current: WeeklyReview; history: WeeklyReview[] }> {
    const [current, rows] = await Promise.all([
      this.live(),
      this.db.q<any>('SELECT data_json FROM pos_weekly_review ORDER BY week_start DESC LIMIT ?', [limit]),
    ]);
    return { current, history: rows.map(r => JSON.parse(r.data_json)) };
  }

  /** 定时任务：上一周出复盘、存档、未推送过就推送。dryRun 只算不存不推。 */
  async run(opts: { dryRun?: boolean; weekStart?: string } = {}) {
    const today = todayCN();
    const weekStart = opts.weekStart ? weekStartOf(opts.weekStart) : shift(weekStartOf(today), -7);
    const review = weeklyReview(await this.input(today), weekStart);
    const text = renderWeekly(review);
    if (opts.dryRun) return { weekStart, posted: false, reason: 'dry_run', text };

    await this.db.exec(
      `INSERT INTO pos_weekly_review (week_start, data_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE data_json = VALUES(data_json)`,
      [weekStart, JSON.stringify(review)]
    );
    const row = await this.db.one<any>('SELECT pushed_at FROM pos_weekly_review WHERE week_start = ?', [weekStart]);
    if (row?.pushed_at) return { weekStart, posted: false, reason: 'already_pushed', text };
    const r = await postIssueComment(process.env.POS_REVIEW_ISSUE || '286', text);
    if (r.ok) await this.db.exec('UPDATE pos_weekly_review SET pushed_at = ? WHERE week_start = ?', [nowCN(), weekStart]);
    return { weekStart, posted: r.ok, reason: r.reason, text };
  }
}
