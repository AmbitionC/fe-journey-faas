import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  Body,
  ALL,
  Config,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { GrowthService } from '../service/growth';
import { MetricsService } from '../service/metrics';
import { NoAuth } from '../decorator/noAuth';
import { resolveUserInfo } from '../common/admin.guard';
import { R } from '../common/base.error.utils';

/**
 * 增长复盘系统接口（全部需管理端登录态）。
 * 使用方法与数据口径：front-end-journey 仓库 docs/growth-review-playbook.md
 */
@Provide()
export class GrowthHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  growthService: GrowthService;

  @Inject()
  redisService: RedisService;

  @Inject()
  metricsService: MetricsService;

  @Config('syncSecret')
  syncSecret: string;

  /** 同 ops：聚合 FaaS 下 ctx.userInfo 未必透传，需用请求头 token 反查 Redis 兜底 */
  private async requireLogin(): Promise<string> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId;
    if (!userId) throw R.unauthorizedError('请先登录');
    return userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '复盘数据一次性导出（只读聚合，x-sync-secret 保护）',
    functionName: 'growthExport',
    name: 'growthExport',
    path: '/growth/export',
    method: 'get',
  })
  @NoAuth()
  async exportReview(
    @Query(ALL) query: { days?: number; excludeUsers?: string }
  ): Promise<any> {
    // 与 /content/sync 同一套密钥头：免登录、无验证码、无 token 过期，
    // 便于外部（如 AI 助手/脚本）一次拉全复盘所需数据。仅返回聚合数字，不含任何个人信息。
    const secret = this.ctx.headers['x-sync-secret'];
    if (!this.syncSecret || secret !== this.syncSecret) {
      throw R.unauthorizedError('导出需要有效的 x-sync-secret');
    }
    const days = Number(query?.days) > 0 ? Number(query.days) : 7;
    // 可选：本次导出额外排除的账号（手机号，逗号分隔），与 config 的
    // GROWTH_INTERNAL_USER_IDS 求并集；便于未配环境变量时先临时拉一份剔除自己的干净数据。
    const excludeUsers = String(query?.excludeUsers || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const [dashboard, overview, funnel, pathFunnel, channels, daily, signupAudit] =
      await Promise.all([
        this.metricsService.overview(excludeUsers).catch(() => null),
        this.growthService.overview(excludeUsers).catch(() => null),
        this.growthService.funnel(days, excludeUsers).catch(() => null),
        this.growthService.pathFunnel(days, excludeUsers).catch(() => null),
        this.growthService.channels(days, excludeUsers).catch(() => null),
        this.growthService.daily(days, excludeUsers).catch(() => null),
        this.growthService.signupAudit(days, excludeUsers).catch(() => null),
      ]);
    return {
      success: true,
      data: {
        days,
        excludeUsers,
        generatedAt: new Date().toISOString(),
        dashboard,
        overview,
        funnel,
        pathFunnel,
        channels,
        daily,
        signupAudit,
      },
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '增长北极星概览',
    functionName: 'growthOverview',
    name: 'growthOverview',
    path: '/growth/overview',
    method: 'get',
  })
  async overview() {
    await this.requireLogin();
    const data = await this.growthService.overview();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '转化漏斗',
    functionName: 'growthFunnel',
    name: 'growthFunnel',
    path: '/growth/funnel',
    method: 'get',
  })
  async funnel(@Query(ALL) query: { days?: number }) {
    await this.requireLogin();
    const data = await this.growthService.funnel(Number(query.days) || 30);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '一条路漏斗（测评→领题→交作业→评审→付费）',
    functionName: 'growthPathFunnel',
    name: 'growthPathFunnel',
    path: '/growth/path-funnel',
    method: 'get',
  })
  async pathFunnel(@Query(ALL) query: { days?: number }) {
    await this.requireLogin();
    const data = await this.growthService.pathFunnel(Number(query.days) || 30);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '渠道拆解',
    functionName: 'growthChannels',
    name: 'growthChannels',
    path: '/growth/channels',
    method: 'get',
  })
  async channels(@Query(ALL) query: { days?: number }) {
    await this.requireLogin();
    const data = await this.growthService.channels(Number(query.days) || 30);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '日趋势(uv/收入)',
    functionName: 'growthDaily',
    name: 'growthDaily',
    path: '/growth/daily',
    method: 'get',
  })
  async daily(@Query(ALL) query: { days?: number }) {
    await this.requireLogin();
    const data = await this.growthService.daily(Number(query.days) || 30);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '手动指标录入(upsert)',
    functionName: 'growthStatSave',
    name: 'growthStatSave',
    path: '/growth/stat/save',
    method: 'post',
  })
  async saveStat(
    @Body(ALL) body: { statDate: string; metric: string; value: number; note?: string }
  ) {
    await this.requireLogin();
    const data = await this.growthService.upsertStat(body);
    return data;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '手动指标列表',
    functionName: 'growthStatList',
    name: 'growthStatList',
    path: '/growth/stat/list',
    method: 'get',
  })
  async listStats(@Query(ALL) query: { metric?: string; days?: number }) {
    await this.requireLogin();
    const data = await this.growthService.listStats({
      metric: query.metric,
      days: query.days ? Number(query.days) : undefined,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除手动指标',
    functionName: 'growthStatDelete',
    name: 'growthStatDelete',
    path: '/growth/stat/delete',
    method: 'post',
  })
  async deleteStat(@Body(ALL) body: { id: number }) {
    await this.requireLogin();
    const data = await this.growthService.deleteStat(Number(body.id));
    return data;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存复盘记录',
    functionName: 'growthReviewSave',
    name: 'growthReviewSave',
    path: '/growth/review/save',
    method: 'post',
  })
  async saveReview(
    @Body(ALL)
    body: { id?: number; period: string; title: string; content: string; status?: string }
  ) {
    await this.requireLogin();
    const data = await this.growthService.saveReview(body);
    return data;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '复盘记录列表',
    functionName: 'growthReviewList',
    name: 'growthReviewList',
    path: '/growth/review/list',
    method: 'get',
  })
  async listReviews(@Query(ALL) query: { page?: number; pageSize?: number }) {
    await this.requireLogin();
    const data = await this.growthService.listReviews({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 10,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除复盘记录',
    functionName: 'growthReviewDelete',
    name: 'growthReviewDelete',
    path: '/growth/review/delete',
    method: 'post',
  })
  async deleteReview(@Body(ALL) body: { id: number }) {
    await this.requireLogin();
    const data = await this.growthService.deleteReview(Number(body.id));
    return data;
  }
}
