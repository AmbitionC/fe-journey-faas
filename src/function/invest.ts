import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { InvestOverviewService } from '../service/invest/overview';
import { InvestPlanService } from '../service/invest/plan';
import { InvestInsightService } from '../service/invest/insight';

/**
 * 投资驾驶舱只读 API：总览 / 每日计划 / 复盘 / 盯盘预警 / 模型健康 / 恐慌指数。
 * 鉴权：AuthMiddleware 对 /invest/* 统一要求 admin（个人持仓/资产数据，
 * 平台普通登录账号不可读）；写接口另有 assertAdmin 兜底。
 */
@Provide()
export class InvestHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  overviewService: InvestOverviewService;

  @Inject()
  planService: InvestPlanService;

  @Inject()
  insightService: InvestInsightService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '驾驶舱总览',
    functionName: 'investOverview',
    name: 'investOverview',
    path: '/invest/overview',
    method: 'get',
  })
  async overview() {
    return { success: true, data: await this.overviewService.overview() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '操作计划日期列表',
    functionName: 'investPlanDates',
    name: 'investPlanDates',
    path: '/invest/plan/dates',
    method: 'get',
  })
  async planDates() {
    return { success: true, data: await this.planService.dates() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '按日三段式操作计划',
    functionName: 'investPlan',
    name: 'investPlan',
    path: '/invest/plan',
    method: 'get',
  })
  async plan(@Query(ALL) q: { date?: string }) {
    return { success: true, data: await this.planService.plan(q.date) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '复盘报告列表',
    functionName: 'investReviewList',
    name: 'investReviewList',
    path: '/invest/review/list',
    method: 'get',
  })
  async reviewList(@Query(ALL) q: { period?: string }) {
    return { success: true, data: await this.insightService.reviewList(q.period) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '复盘报告详情',
    functionName: 'investReview',
    name: 'investReview',
    path: '/invest/review',
    method: 'get',
  })
  async review(@Query(ALL) q: { date: string; period?: string }) {
    return {
      success: true,
      data: await this.insightService.review(q.date, q.period || 'weekly'),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '盯盘预警分页',
    functionName: 'investAlerts',
    name: 'investAlerts',
    path: '/invest/alerts',
    method: 'get',
  })
  async alerts(
    @Query(ALL)
    q: { date?: string; kind?: string; severity?: string; page?: string; pageSize?: string }
  ) {
    return {
      success: true,
      data: await this.insightService.alerts({
        date: q.date,
        kind: q.kind,
        severity: q.severity,
        page: Number(q.page) || 1,
        pageSize: Number(q.pageSize) || 50,
      }),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '模型注册表',
    functionName: 'investModelRegistry',
    name: 'investModelRegistry',
    path: '/invest/model/registry',
    method: 'get',
  })
  async registry() {
    return { success: true, data: await this.insightService.registry() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '因子IC序列',
    functionName: 'investModelIc',
    name: 'investModelIc',
    path: '/invest/model/ic',
    method: 'get',
  })
  async ic(@Query(ALL) q: { factor?: string; horizon?: string; start?: string; end?: string }) {
    return {
      success: true,
      data: await this.insightService.ic({
        factor: q.factor,
        horizon: q.horizon ? Number(q.horizon) : undefined,
        start: q.start,
        end: q.end,
      }),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '回测NAV与指标',
    functionName: 'investModelBacktest',
    name: 'investModelBacktest',
    path: '/invest/model/backtest',
    method: 'get',
  })
  async backtest(@Query(ALL) q: { runId?: string }) {
    return {
      success: true,
      data: await this.insightService.backtest(q.runId ? Number(q.runId) : undefined),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '恐慌指数最新',
    functionName: 'investFearLatest',
    name: 'investFearLatest',
    path: '/invest/fear/latest',
    method: 'get',
  })
  async fearLatest() {
    return { success: true, data: await this.insightService.fearLatest() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'P28/P30 杠杆信号最新状态',
    functionName: 'investLeverage',
    name: 'investLeverage',
    path: '/invest/leverage',
    method: 'get',
  })
  async leverage() {
    return { success: true, data: await this.insightService.leverageLatest() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '恐慌指数序列',
    functionName: 'investFearSeries',
    name: 'investFearSeries',
    path: '/invest/fear/series',
    method: 'get',
  })
  async fearSeries(@Query(ALL) q: { start?: string; end?: string }) {
    return { success: true, data: await this.insightService.fearSeries(q.start, q.end) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    path: '/invest/health',
    method: 'get',
  })
  async health() {
    return { success: true, data: await this.insightService.health() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    path: '/invest/shadow',
    method: 'get',
  })
  async shadow() {
    return { success: true, data: await this.insightService.shadow() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    path: '/invest/signal-scorecard',
    method: 'get',
  })
  async signalScorecard() {
    return { success: true, data: await this.insightService.signalScorecard() };
  }
}
