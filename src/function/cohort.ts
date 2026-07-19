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
import { CohortService } from '../service/cohort';
import { MetricsService } from '../service/metrics';
import { resolveUserInfo, assertAdmin } from '../common/admin.guard';
import { NoAuth } from '../decorator/noAuth';

@Provide()
export class CohortHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  cohortService: CohortService;

  @Inject()
  metricsService: MetricsService;

  private async userId(): Promise<string | undefined> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    return info?.userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前同期挑战期次',
    functionName: 'cohortCurrent',
    name: 'cohortCurrent',
    path: '/cohort/current',
    method: 'get',
  })
  @NoAuth()
  async current() {
    const data = await this.cohortService.current();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '报名加入期次',
    functionName: 'cohortJoin',
    name: 'cohortJoin',
    path: '/cohort/join',
    method: 'post',
  })
  @NoAuth()
  async join(@Body(ALL) body: { slug: string; nickName?: string; anonymous?: boolean }) {
    const uid = await this.userId();
    if (!uid) return { success: false, message: '请先登录' };
    const data = await this.cohortService.join(uid, body.slug, body.nickName || '', body.anonymous);
    this.metricsService.track({ userId: uid, event: 'cohort_join', props: { slug: body.slug } }).catch(() => {});
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '期次进度榜',
    functionName: 'cohortLeaderboard',
    name: 'cohortLeaderboard',
    path: '/cohort/leaderboard',
    method: 'get',
  })
  @NoAuth()
  async leaderboard(@Query('slug') slug: string) {
    const data = await this.cohortService.leaderboard(slug);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '期次已发布内容',
    functionName: 'cohortPosts',
    name: 'cohortPosts',
    path: '/cohort/posts',
    method: 'get',
  })
  @NoAuth()
  async posts(@Query('slug') slug: string) {
    const data = await this.cohortService.posts(slug);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '期次数据出口（管理员，供外部 skill 起草周报）',
    functionName: 'cohortWeeklyData',
    name: 'cohortWeeklyData',
    path: '/cohort/ops/weekly-data',
    method: 'get',
  })
  @NoAuth()
  async weeklyData(@Query('slug') slug: string) {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.cohortService.weeklyData(slug);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '幂等发布期次内容（管理员）',
    functionName: 'cohortPublish',
    name: 'cohortPublish',
    path: '/cohort/ops/publish',
    method: 'post',
  })
  @NoAuth()
  async publish(@Body(ALL) body: { slug: string; idemKey: string; title?: string; content: string }) {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.cohortService.publish(body.slug, body);
    return { success: true, data };
  }

  // ---- manager 期次管理 ----

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '期次管理列表',
    functionName: 'cohortManageList',
    name: 'cohortManageList',
    path: '/cohort/manage/list',
    method: 'get',
  })
  @NoAuth()
  async manageList() {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.cohortService.manageList();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存期次',
    functionName: 'cohortManageSave',
    name: 'cohortManageSave',
    path: '/cohort/manage/save',
    method: 'post',
  })
  @NoAuth()
  async manageSave(@Body(ALL) body: any) {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.cohortService.manageSave(body);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '期次状态',
    functionName: 'cohortManageStatus',
    name: 'cohortManageStatus',
    path: '/cohort/manage/status',
    method: 'post',
  })
  @NoAuth()
  async manageStatus(@Body(ALL) body: { slug: string; status: 'upcoming' | 'active' | 'ended' }) {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.cohortService.manageStatus(body.slug, body.status);
    return { success: true, data };
  }
}
