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
import { GrowthService } from '../service/growth';
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

  private requireLogin() {
    const userId = this.ctx.userInfo?.userId;
    if (!userId) throw R.unauthorizedError('请先登录');
    return userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '增长北极星概览',
    functionName: 'growthOverview',
    name: 'growthOverview',
    path: '/growth/overview',
    method: 'get',
  })
  async overview() {
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
    const data = await this.growthService.deleteReview(Number(body.id));
    return data;
  }
}
