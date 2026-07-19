import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { PlanService } from '../service/plan';
import { EntitlementService } from '../service/entitlement';
import { ArticleService } from '../service/article';
import { MetricsService } from '../service/metrics';
import { resolveUserInfo, assertAdmin } from '../common/admin.guard';
import { NoAuth } from '../decorator/noAuth';

@Provide()
export class PlanHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  planService: PlanService;

  @Inject()
  entitlementService: EntitlementService;

  @Inject()
  articleService: ArticleService;

  @Inject()
  metricsService: MetricsService;

  private async resolveUser(): Promise<{ userId: string; isMember: boolean }> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    if (info?.userId) {
      const isMember = await this.entitlementService.isMember(info.userId);
      return { userId: info.userId, isMember };
    }
    return { userId: '', isMember: false };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '测评：行为数据上下文（供裁剪问卷）',
    functionName: 'planAssessContext',
    name: 'planAssessContext',
    path: '/plan/assessment/context',
    method: 'get',
  })
  @NoAuth()
  async assessContext() {
    const { userId } = await this.resolveUser();
    if (!userId) return { success: true, data: { summary: '', hasBehavior: false } };
    const summary = await this.articleService.getProfileSummary(userId, 'knowledge').catch(() => '');
    return { success: true, data: { summary, hasBehavior: !!summary } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '测评提交（回写画像 + 起点判定）',
    functionName: 'planAssessSubmit',
    name: 'planAssessSubmit',
    path: '/plan/assessment/submit',
    method: 'post',
  })
  @NoAuth()
  async assessSubmit(@Body(ALL) body: any) {
    const { userId } = await this.resolveUser();
    if (!userId) return { success: false, message: '请先登录' };
    const data = await this.planService.submitAssessment(userId, body);
    this.metricsService
      .track({ userId, event: 'onboarding_assess_done', props: { goal: body?.goal, weeklyHours: body?.weeklyHours } })
      .catch(() => {});
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '生成学习计划（会员走个性化，否则静态骨架）',
    functionName: 'planGenerate',
    name: 'planGenerate',
    path: '/plan/generate',
    method: 'post',
  })
  @NoAuth()
  async generate(@Body(ALL) body: any) {
    const { userId, isMember } = await this.resolveUser();
    if (!userId) return { success: false, message: '请先登录' };
    const data = await this.planService.generate(userId, body, isMember);
    this.metricsService
      .track({ userId, event: 'plan_generate_done', props: { source: data?.plan?.source, totalWeeks: data?.plan?.totalWeeks } })
      .catch(() => {});
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前学习计划详情',
    functionName: 'planDetail',
    name: 'planDetail',
    path: '/plan/detail',
    method: 'get',
  })
  @NoAuth()
  async detail() {
    const { userId } = await this.resolveUser();
    if (!userId) return { success: true, data: null };
    const data = await this.planService.detail(userId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '计划节点完成回填',
    functionName: 'planNodeComplete',
    name: 'planNodeComplete',
    path: '/plan/node/complete',
    method: 'post',
  })
  @NoAuth()
  async nodeComplete(@Body(ALL) body: { weekNo: number; nodeRef: string }) {
    const { userId } = await this.resolveUser();
    if (!userId) return { success: false, message: '请先登录' };
    const data = await this.planService.completeNode(userId, body.weekNo, body.nodeRef);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '周对账提交',
    functionName: 'planCheckin',
    name: 'planCheckin',
    path: '/plan/checkin',
    method: 'post',
  })
  @NoAuth()
  async checkin(@Body(ALL) body: any) {
    const { userId } = await this.resolveUser();
    if (!userId) return { success: false, message: '请先登录' };
    const data = await this.planService.checkin(userId, body.weekNo, body);
    this.metricsService.track({ userId, event: 'plan_checkin_submit', props: { weekNo: body.weekNo } }).catch(() => {});
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '计划调整（时间档/暂停/恢复/放弃）',
    functionName: 'planAdjust',
    name: 'planAdjust',
    path: '/plan/adjust',
    method: 'post',
  })
  @NoAuth()
  async adjust(@Body(ALL) body: { type: 'hours' | 'pause' | 'resume' | 'abandon'; weeklyHours?: string }) {
    const { userId } = await this.resolveUser();
    if (!userId) return { success: false, message: '请先登录' };
    const data = await this.planService.adjust(userId, body.type, body);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '周对账汇总（管理员，供外部 skill 起草群提醒）',
    functionName: 'planCheckinSummary',
    name: 'planCheckinSummary',
    path: '/plan/checkin/summary',
    method: 'get',
  })
  @NoAuth()
  async checkinSummary() {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.planService.checkinSummary();
    return { success: true, data };
  }
}
