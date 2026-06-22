import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { MetricsService } from '../service/metrics';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';

class TrackDTO {
  event: string;
  props?: any;
  userId?: string;
}

@Provide()
export class MetricsHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  metricsService: MetricsService;

  @Inject()
  redisService: RedisService;

  private async resolveUserId(): Promise<string | undefined> {
    const header = (this.ctx.header || {}) as any;
    const token = header.token || header.authorization?.replace('Bearer ', '');
    if (!token) return undefined;
    try {
      const s = await this.redisService.get(`token:${token}`);
      return s ? JSON.parse(s).userId : undefined;
    } catch {
      return undefined;
    }
  }

  private requireLogin() {
    const userId = this.ctx.userInfo?.userId;
    if (!userId) throw R.unauthorizedError('请先登录');
    return userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '埋点上报',
    functionName: 'trackEvent',
    name: 'trackEvent',
    path: '/event/track',
    method: 'post',
  })
  @NoAuth()
  async track(@Body(ALL) body: TrackDTO) {
    if (!body?.event) return { success: true, data: {} };
    const userId = (await this.resolveUserId()) || body.userId;
    const ip =
      this.ctx.get('x-forwarded-for')?.split(',')[0]?.trim() || this.ctx.ip || '';
    const ua = this.ctx.get('user-agent') || '';
    await this.metricsService.track({ userId, event: body.event, props: body.props, ua, ip });
    return { success: true, data: {} };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '看板概览',
    functionName: 'metricsOverview',
    name: 'metricsOverview',
    path: '/metrics/overview',
    method: 'get',
  })
  async overview() {
    this.requireLogin();
    const data = await this.metricsService.overview();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '近 N 天事件计数',
    functionName: 'metricsEvents',
    name: 'metricsEvents',
    path: '/metrics/events',
    method: 'get',
  })
  async events(@Query(ALL) query: { days?: number }) {
    this.requireLogin();
    const data = await this.metricsService.events(Number(query.days) || 7);
    return { success: true, data: { list: data } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '在线跑评测集并存档',
    functionName: 'metricsEvalRun',
    name: 'metricsEvalRun',
    path: '/metrics/eval/run',
    method: 'post',
  })
  async evalRun() {
    this.requireLogin();
    const data = await this.metricsService.runEval();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '最新评测报告',
    functionName: 'metricsEvalLatest',
    name: 'metricsEvalLatest',
    path: '/metrics/eval/latest',
    method: 'get',
  })
  async evalLatest() {
    this.requireLogin();
    const data = await this.metricsService.latestEval();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 调用查询',
    functionName: 'metricsAiCalls',
    name: 'metricsAiCalls',
    path: '/metrics/aiCalls',
    method: 'get',
  })
  async aiCalls(@Query(ALL) query: any) {
    this.requireLogin();
    const data = await this.metricsService.aiCalls({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      route: query.route,
      status: query.status,
    });
    return { success: true, data };
  }
}
