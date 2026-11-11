import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  Query,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { ReviewService } from '../service/review';
import { MetricsService } from '../service/metrics';
import { resolveUserInfo, assertAdmin } from '../common/admin.guard';
import { NoAuth } from '../decorator/noAuth';

@Provide()
export class ReviewHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  reviewService: ReviewService;

  @Inject()
  metricsService: MetricsService;

  private async userId(): Promise<string | undefined> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    return info?.userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '手动触发/重跑评审（管理员或本人）',
    functionName: 'reviewRun',
    name: 'reviewRun',
    path: '/review/run',
    method: 'post',
  })
  @NoAuth()
  async run(@Body(ALL) body: { submissionId: number }) {
    // 本人或管理员均可触发（重跑）；这里做管理员校验以防滥用重跑刷成本
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.reviewService.runReview(body.submissionId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '评审报告（本人）',
    functionName: 'reviewDetail',
    name: 'reviewDetail',
    path: '/review/detail',
    method: 'get',
  })
  @NoAuth()
  async detail(@Query('submissionId') submissionId: string) {
    const uid = await this.userId();
    if (!uid) return { success: false, message: '请先登录' };
    const data = await this.reviewService.getReport(uid, Number(submissionId));
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '人工复核评审（管理员）',
    functionName: 'reviewHuman',
    name: 'reviewHuman',
    path: '/review/human',
    method: 'post',
  })
  @NoAuth()
  async human(@Body(ALL) body: { reviewId: number; verdict: 'pass' | 'rework'; note?: string }) {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.reviewService.humanReview(body.reviewId, body.verdict, body.note);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '公开只读评审报告（分享卡）',
    functionName: 'reviewShared',
    name: 'reviewShared',
    path: '/review/shared',
    method: 'get',
  })
  @NoAuth()
  async shared(@Query('code') code: string, @Query('ch') ch: string) {
    const data = await this.reviewService.getSharedReport(code);
    this.metricsService
      .track({ event: 'review_share_view', props: { code }, channel: ch || `review-${code}`, ip: this.ctx.ip })
      .catch(() => {});
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '设置作品档案可见性（本人）',
    functionName: 'portfolioConfig',
    name: 'portfolioConfig',
    path: '/portfolio/config',
    method: 'post',
  })
  @NoAuth()
  async portfolioConfig(@Body(ALL) body: { visible?: boolean; headline?: string }) {
    const uid = await this.userId();
    if (!uid) return { success: false, message: '请先登录' };
    const data = await this.reviewService.setPortfolioConfig(uid, body);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '作品档案（公开页）',
    functionName: 'portfolioGet',
    name: 'portfolioGet',
    path: '/portfolio',
    method: 'get',
  })
  @NoAuth()
  async portfolio(@Query('slug') slug: string, @Query('ch') ch: string) {
    const data = await this.reviewService.getPortfolio(slug);
    // 分享回流曝光埋点（渠道 portfolio-{slug}）
    this.metricsService
      .track({ event: 'portfolio_view', props: { slug }, channel: ch || `portfolio-${slug}`, ip: this.ctx.ip })
      .catch(() => {});
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '我的能力曲线',
    functionName: 'skillCurve',
    name: 'skillCurve',
    path: '/skill/curve',
    method: 'get',
  })
  @NoAuth()
  async curve() {
    const uid = await this.userId();
    if (!uid) return { success: false, message: '请先登录' };
    const data = await this.reviewService.skillCurve(uid);
    return { success: true, data };
  }
}
