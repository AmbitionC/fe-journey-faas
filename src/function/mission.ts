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
import { MissionService } from '../service/mission';
import { ReviewService } from '../service/review';
import { EntitlementService } from '../service/entitlement';
import { MetricsService } from '../service/metrics';
import { resolveUserInfo, assertAdmin } from '../common/admin.guard';
import { NoAuth } from '../decorator/noAuth';

@Provide()
export class MissionHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  missionService: MissionService;

  @Inject()
  reviewService: ReviewService;

  @Inject()
  entitlementService: EntitlementService;

  @Inject()
  metricsService: MetricsService;

  /** 解析登录用户 + 会员态（游客以 guest:ip 标识）。 */
  private async resolveUser(): Promise<{ userId: string; isMember: boolean }> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    if (info?.userId) {
      const isMember = await this.entitlementService.isMember(info.userId);
      return { userId: info.userId, isMember };
    }
    const fwd = this.ctx.headers['x-forwarded-for'] as string;
    const ip = (fwd ? fwd.split(',')[0].trim() : '') || this.ctx.ip || 'anonymous';
    const isMember = await this.entitlementService.isMember(`guest:${ip}`);
    return { userId: `guest:${ip}`, isMember };
  }

  private track(userId: string, event: string, props?: any) {
    this.metricsService
      .track({ userId, event, props, ip: this.ctx.ip })
      .catch(() => {});
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '题卡详情 + 当前用户做题状态',
    functionName: 'missionDetail',
    name: 'missionDetail',
    path: '/mission/detail',
    method: 'get',
  })
  @NoAuth()
  async detail(@Query('slug') slug: string) {
    const { userId } = await this.resolveUser();
    const data = await this.missionService.detail(slug, userId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '题库列表（已发布 + 锁态）',
    functionName: 'missionList',
    name: 'missionList',
    path: '/mission/list',
    method: 'get',
  })
  @NoAuth()
  async list(@Query('tier') tier: string) {
    const { userId, isMember } = await this.resolveUser();
    const data = await this.missionService.list(tier, userId, isMember);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '领题',
    functionName: 'missionClaim',
    name: 'missionClaim',
    path: '/mission/claim',
    method: 'post',
  })
  @NoAuth()
  async claim(@Body(ALL) body: { slug: string }) {
    const { userId, isMember } = await this.resolveUser();
    const data = await this.missionService.claim(userId, body.slug, isMember);
    this.track(userId, 'mission_claim', { slug: body.slug });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '先想后做：提交指挥方案',
    functionName: 'missionPlan',
    name: 'missionPlan',
    path: '/mission/plan',
    method: 'post',
  })
  @NoAuth()
  async plan(@Body(ALL) body: { submissionId: number; understand: string; breakdown: string; firstPrompt: string }) {
    const { userId } = await this.resolveUser();
    const data = await this.missionService.submitPlan(userId, body.submissionId, {
      understand: body.understand,
      breakdown: body.breakdown,
      firstPrompt: body.firstPrompt,
    });
    this.track(userId, 'mission_plan_submit', { submissionId: body.submissionId });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '交作业（GitHub 链接 + 三问复盘）',
    functionName: 'missionSubmit',
    name: 'missionSubmit',
    path: '/mission/submit',
    method: 'post',
  })
  @NoAuth()
  async submit(@Body(ALL) body: { submissionId: number; repoUrl: string; deployUrl?: string; retro: any }) {
    const { userId } = await this.resolveUser();
    const data = await this.missionService.submitWork(userId, body.submissionId, {
      repoUrl: body.repoUrl,
      deployUrl: body.deployUrl,
      retro: body.retro,
    });
    this.track(userId, 'mission_submit', { submissionId: body.submissionId });
    // 交作业成功 → 异步触发 AI 评审（REVIEW_ENABLED 关闭时为空操作）
    this.reviewService.triggerAsync(body.submissionId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '我的做题列表',
    functionName: 'missionMy',
    name: 'missionMy',
    path: '/mission/my',
    method: 'get',
  })
  @NoAuth()
  async my() {
    const { userId } = await this.resolveUser();
    const data = await this.missionService.my(userId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '放弃做题',
    functionName: 'missionAbandon',
    name: 'missionAbandon',
    path: '/mission/abandon',
    method: 'post',
  })
  @NoAuth()
  async abandon(@Body(ALL) body: { submissionId: number }) {
    const { userId } = await this.resolveUser();
    const data = await this.missionService.abandon(userId, body.submissionId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '追加过程手记',
    functionName: 'missionJournal',
    name: 'missionJournal',
    path: '/mission/journal',
    method: 'post',
  })
  @NoAuth()
  async journal(@Body(ALL) body: { submissionId: number; content: string }) {
    const { userId } = await this.resolveUser();
    const data = await this.missionService.appendJournal(userId, body.submissionId, body.content);
    return { success: true, data };
  }

  // ---- manager 题卡管理 ----

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '题卡管理列表（含数据列）',
    functionName: 'missionManageList',
    name: 'missionManageList',
    path: '/mission/manage/list',
    method: 'get',
  })
  @NoAuth()
  async manageList() {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.missionService.manageList();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存题卡（新建/编辑）',
    functionName: 'missionManageSave',
    name: 'missionManageSave',
    path: '/mission/manage/save',
    method: 'post',
  })
  @NoAuth()
  async manageSave(@Body(ALL) body: any) {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.missionService.manageSave(body);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '题卡状态（发布/下架）',
    functionName: 'missionManageStatus',
    name: 'missionManageStatus',
    path: '/mission/manage/status',
    method: 'post',
  })
  @NoAuth()
  async manageStatus(@Body(ALL) body: { slug: string; status: 'draft' | 'published' | 'offline' }) {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.missionService.manageStatus(body.slug, body.status);
    return { success: true, data };
  }
}
