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
import { LearningService } from '../service/learning';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';

class GoalSaveDTO {
  target: string;
  level?: string;
  interests?: string[];
  note?: string;
  userId?: string;
}

@Provide()
export class LearningHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  learningService: LearningService;

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
    description: '获取学习目标',
    functionName: 'getGoal',
    name: 'getGoal',
    path: '/article/goal',
    method: 'get',
  })
  @NoAuth()
  async getGoal(@Query(ALL) query: { userId?: string }) {
    const userId = (await this.resolveUserId()) || query.userId || '';
    if (!userId) return { success: true, data: null };
    const data = await this.learningService.getGoal(userId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存学习目标（新手引导）',
    functionName: 'saveGoal',
    name: 'saveGoal',
    path: '/article/goal/save',
    method: 'post',
  })
  @NoAuth()
  async saveGoal(@Body(ALL) body: GoalSaveDTO) {
    const userId = (await this.resolveUserId()) || body.userId || '';
    if (!userId) return { success: false, message: '请先登录' };
    const data = await this.learningService.saveGoal({
      userId,
      target: body.target,
      level: body.level,
      interests: body.interests,
      note: body.note,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '学习路径列表',
    functionName: 'listPaths',
    name: 'listPaths',
    path: '/article/paths',
    method: 'get',
  })
  @NoAuth()
  async listPaths() {
    const data = await this.learningService.listPaths(false);
    return { success: true, data: { list: data } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '学习路径详情',
    functionName: 'pathDetail',
    name: 'pathDetail',
    path: '/article/path/detail',
    method: 'get',
  })
  @NoAuth()
  async pathDetail(@Query(ALL) query: { slug: string }) {
    const data = await this.learningService.getPath(query.slug);
    return { success: true, data };
  }

  // ===== 管理端 =====

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '管理端路径列表（含草稿）',
    functionName: 'adminListPaths',
    name: 'adminListPaths',
    path: '/article/path/adminList',
    method: 'get',
  })
  async adminList() {
    this.requireLogin();
    const data = await this.learningService.listPaths(true);
    return { success: true, data: { list: data } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存学习路径',
    functionName: 'savePath',
    name: 'savePath',
    path: '/article/path/save',
    method: 'post',
  })
  async savePath(@Body(ALL) body: any) {
    this.requireLogin();
    const data = await this.learningService.savePath(body);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除学习路径',
    functionName: 'deletePath',
    name: 'deletePath',
    path: '/article/path/delete',
    method: 'post',
  })
  async deletePath(@Body(ALL) body: { id: number }) {
    this.requireLogin();
    const data = await this.learningService.deletePath(body.id);
    return { success: true, data };
  }
}
