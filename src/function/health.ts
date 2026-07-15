import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Config,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';
import { HealthBodyService } from '../service/health/body';
import { HealthMealService } from '../service/health/meal';
import { HealthActivityService } from '../service/health/activity';
import { HealthBudgetService } from '../service/health/budget';
import { HealthProfileService } from '../service/health/profile';
import { HealthAdviceService } from '../service/health/advice';

/** 北京时间今天（FC 实例时区不可控，显式按 UTC+8 折算）。 */
function todayCN(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 个人健康管理 API（/health/*）。
 *
 * 与主站用户体系完全解耦：全部路由 @NoAuth 跳过登录中间件，
 * 改用独立的 X-Health-Token（环境变量 HEALTH_API_TOKEN）校验——
 * 前端(health-journey)与 iOS 快捷指令共用该 token。
 */
@Provide()
export class HealthHTTPService {
  @Inject()
  ctx: Context;

  @Config('health')
  healthConfig: { apiToken: string };

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
  adviceService: HealthAdviceService;

  /** 独立鉴权：未配置 HEALTH_API_TOKEN 时一律拒绝（安全兜底）。 */
  private assertToken() {
    const expected = this.healthConfig?.apiToken;
    if (!expected)
      throw R.forbiddenError('健康模块未配置访问令牌（HEALTH_API_TOKEN）');
    const headers: any =
      (this.ctx as any).headers || (this.ctx as any).header || {};
    const got =
      headers['x-health-token'] ||
      (headers.authorization || '').replace('Bearer ', '');
    if (got !== expected) throw R.unauthorizedError('健康模块令牌无效');
  }

  // ---------- 总览 ----------

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '健康模块连通性检查',
    functionName: 'healthPing',
    name: 'healthPing',
    path: '/health/ping',
    method: 'get',
  })
  @NoAuth()
  async ping() {
    this.assertToken();
    return { success: true, data: { pong: true, today: todayCN() } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '首页总览聚合',
    functionName: 'healthOverview',
    name: 'healthOverview',
    path: '/health/overview',
    method: 'get',
  })
  @NoAuth()
  async overview(@Query(ALL) q: { date?: string }) {
    this.assertToken();
    const date = q.date || todayCN();
    const [latestBody, bodyTrend, day, budget, activity, profile] =
      await Promise.all([
        this.bodyService.latest(),
        this.bodyService.trend(90),
        this.mealService.day(date),
        this.budgetService.current(),
        this.activityService.byDate(date),
        this.profileService.get(),
      ]);
    // 目标进度：距下一个阶段目标还差多少
    const goals = profile.goals || [];
    const currentWeight = latestBody?.weightKg ?? null;
    const nextGoal =
      currentWeight != null
        ? goals.find(
            g =>
              g.metric === 'weight_kg' &&
              g.value != null &&
              currentWeight > g.value
          ) || null
        : null;
    return {
      success: true,
      data: {
        date,
        latestBody,
        bodyTrend,
        today: day,
        budget,
        activity,
        goals,
        nextGoal,
        nextGoalRemainingKg:
          nextGoal && currentWeight != null
            ? Math.round((currentWeight - (nextGoal.value as number)) * 100) /
              100
            : null,
      },
    };
  }

  // ---------- 体成分 ----------

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '体成分记录列表（倒序）',
    functionName: 'healthBodyList',
    name: 'healthBodyList',
    path: '/health/body/list',
    method: 'get',
  })
  @NoAuth()
  async bodyList(@Query(ALL) q: { limit?: string }) {
    this.assertToken();
    return {
      success: true,
      data: await this.bodyService.list(Number(q.limit) || 100),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '体成分趋势（升序）',
    functionName: 'healthBodyTrend',
    name: 'healthBodyTrend',
    path: '/health/body/trend',
    method: 'get',
  })
  @NoAuth()
  async bodyTrend(@Query(ALL) q: { days?: string }) {
    this.assertToken();
    return {
      success: true,
      data: await this.bodyService.trend(Number(q.days) || 365),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '新增/覆盖体成分记录（按日期幂等）',
    functionName: 'healthBodyUpsert',
    name: 'healthBodyUpsert',
    path: '/health/body',
    method: 'post',
  })
  @NoAuth()
  async bodyUpsert(@Body(ALL) body: any) {
    this.assertToken();
    return { success: true, data: await this.bodyService.upsert(body) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除体成分记录',
    functionName: 'healthBodyDelete',
    name: 'healthBodyDelete',
    path: '/health/body/delete',
    method: 'post',
  })
  @NoAuth()
  async bodyDelete(@Body(ALL) body: { date: string }) {
    this.assertToken();
    await this.bodyService.remove(body.date);
    return { success: true };
  }

  // ---------- 饮食 ----------

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '某日餐次与汇总',
    functionName: 'healthMealDay',
    name: 'healthMealDay',
    path: '/health/meal/day',
    method: 'get',
  })
  @NoAuth()
  async mealDay(@Query(ALL) q: { date?: string }) {
    this.assertToken();
    return {
      success: true,
      data: await this.mealService.day(q.date || todayCN()),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '日期区间每日摄入汇总',
    functionName: 'healthMealRange',
    name: 'healthMealRange',
    path: '/health/meal/range',
    method: 'get',
  })
  @NoAuth()
  async mealRange(@Query(ALL) q: { start?: string; end?: string }) {
    this.assertToken();
    const end = q.end || todayCN();
    const start =
      q.start ||
      new Date(new Date(end).getTime() - 29 * 86400 * 1000)
        .toISOString()
        .slice(0, 10);
    return { success: true, data: await this.mealService.range(start, end) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '新增一餐记录',
    functionName: 'healthMealAdd',
    name: 'healthMealAdd',
    path: '/health/meal',
    method: 'post',
  })
  @NoAuth()
  async mealAdd(@Body(ALL) body: any) {
    this.assertToken();
    return { success: true, data: await this.mealService.add(body) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '更新一餐记录',
    functionName: 'healthMealUpdate',
    name: 'healthMealUpdate',
    path: '/health/meal/update',
    method: 'post',
  })
  @NoAuth()
  async mealUpdate(@Body(ALL) body: any) {
    this.assertToken();
    const { id, ...patch } = body || {};
    if (!id) throw R.validateError('缺少 id');
    return {
      success: true,
      data: await this.mealService.update(Number(id), patch),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除一餐记录',
    functionName: 'healthMealDelete',
    name: 'healthMealDelete',
    path: '/health/meal/delete',
    method: 'post',
  })
  @NoAuth()
  async mealDelete(@Body(ALL) body: { id: number }) {
    this.assertToken();
    if (!body?.id) throw R.validateError('缺少 id');
    await this.mealService.remove(Number(body.id));
    return { success: true };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '拍照识别食物热量（不落库，确认后再提交）',
    functionName: 'healthMealRecognize',
    name: 'healthMealRecognize',
    path: '/health/meal/recognize',
    method: 'post',
  })
  @NoAuth()
  async mealRecognize(
    @Body(ALL) body: { imageBase64?: string; hint?: string }
  ) {
    this.assertToken();
    return {
      success: true,
      data: await this.adviceService.recognize(
        body?.imageBase64 || '',
        body?.hint
      ),
    };
  }

  // ---------- 活动（Apple Watch / iOS 快捷指令）----------

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'iOS 快捷指令每日活动同步（按日期幂等覆盖）',
    functionName: 'healthActivitySync',
    name: 'healthActivitySync',
    path: '/health/activity/sync',
    method: 'post',
  })
  @NoAuth()
  async activitySync(@Body(ALL) body: any) {
    this.assertToken();
    return { success: true, data: await this.activityService.sync(body || {}) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '活动数据列表（升序）',
    functionName: 'healthActivityList',
    name: 'healthActivityList',
    path: '/health/activity/list',
    method: 'get',
  })
  @NoAuth()
  async activityList(@Query(ALL) q: { days?: string }) {
    this.assertToken();
    return {
      success: true,
      data: await this.activityService.list(Number(q.days) || 30),
    };
  }

  // ---------- 预算 / 档案 / 建议 ----------

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前热量与宏量预算（含计算依据）',
    functionName: 'healthBudget',
    name: 'healthBudget',
    path: '/health/budget',
    method: 'get',
  })
  @NoAuth()
  async budget() {
    this.assertToken();
    return { success: true, data: await this.budgetService.current() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '个人档案与目标',
    functionName: 'healthProfileGet',
    name: 'healthProfileGet',
    path: '/health/profile',
    method: 'get',
  })
  @NoAuth()
  async profileGet() {
    this.assertToken();
    return { success: true, data: await this.profileService.get() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '更新个人档案与目标',
    functionName: 'healthProfileUpdate',
    name: 'healthProfileUpdate',
    path: '/health/profile/update',
    method: 'post',
  })
  @NoAuth()
  async profileUpdate(@Body(ALL) body: any) {
    this.assertToken();
    return {
      success: true,
      data: await this.profileService.update(body || {}),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '今日饮食建议（AI 或规则兜底）',
    functionName: 'healthAdviceToday',
    name: 'healthAdviceToday',
    path: '/health/advice/today',
    method: 'get',
  })
  @NoAuth()
  async adviceToday(@Query(ALL) q: { date?: string }) {
    this.assertToken();
    return {
      success: true,
      data: await this.adviceService.todayAdvice(q.date || todayCN()),
    };
  }
}
