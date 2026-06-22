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
import { Config } from '@midwayjs/core';
import { NotifyService } from '../service/notify';
import { NoAuth } from '../decorator/noAuth';

class SubscribeDTO {
  channel: string;
  address: string;
  types?: string[];
  userId?: string;
}

@Provide()
export class NotifyHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  notifyService: NotifyService;

  @Inject()
  redisService: RedisService;

  @Config('syncSecret')
  syncSecret: string;

  private async resolveUserId(fallback?: string): Promise<string | undefined> {
    const header = (this.ctx.header || {}) as any;
    const token = header.token || header.authorization?.replace('Bearer ', '');
    if (token) {
      try {
        const s = await this.redisService.get(`token:${token}`);
        if (s) return JSON.parse(s).userId;
      } catch {
        /* ignore */
      }
    }
    return fallback;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '订阅复习提醒/周报',
    functionName: 'notifySubscribe',
    name: 'notifySubscribe',
    path: '/notify/subscribe',
    method: 'post',
  })
  @NoAuth()
  async subscribe(@Body(ALL) body: SubscribeDTO) {
    const userId = await this.resolveUserId(body.userId);
    if (!userId) return { success: false, message: '请先登录' };
    if (!body.address) return { success: false, message: '地址不能为空' };
    const data = await this.notifyService.subscribe({
      userId,
      channel: body.channel || 'email',
      address: body.address,
      types: body.types,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '取消订阅',
    functionName: 'notifyUnsubscribe',
    name: 'notifyUnsubscribe',
    path: '/notify/unsubscribe',
    method: 'post',
  })
  @NoAuth()
  async unsubscribe(@Body(ALL) body: { channel: string; userId?: string }) {
    const userId = await this.resolveUserId(body.userId);
    if (!userId) return { success: false, message: '请先登录' };
    const data = await this.notifyService.unsubscribe(userId, body.channel || 'email');
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '订阅状态',
    functionName: 'notifyStatus',
    name: 'notifyStatus',
    path: '/notify/status',
    method: 'get',
  })
  @NoAuth()
  async status(@Query(ALL) query: { userId?: string }) {
    const userId = await this.resolveUserId(query.userId);
    if (!userId) return { success: true, data: { subscriptions: [] } };
    const data = await this.notifyService.status(userId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '定时投递学习简报（FC 定时触发，需 secret）',
    functionName: 'notifyCronRun',
    name: 'notifyCronRun',
    path: '/notify/cron/run',
    method: 'post',
  })
  @NoAuth()
  async cronRun(@Query(ALL) query: { secret?: string }) {
    // 仅允许带正确 secret 的调用（FC 定时触发器配置同一 secret）
    if (!this.syncSecret || query.secret !== this.syncSecret) {
      this.ctx.status = 403;
      return { success: false, message: 'forbidden' };
    }
    const data = await this.notifyService.runDigestCron();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '学习简报（复习清单 + 可选周报）',
    functionName: 'notifyDigest',
    name: 'notifyDigest',
    path: '/notify/digest',
    method: 'get',
  })
  @NoAuth()
  async digest(@Query(ALL) query: { module: string; userId?: string; weekly?: string }) {
    const userId = await this.resolveUserId(query.userId);
    if (!userId) return { success: true, data: { reviewDueCount: 0, reviewDue: [], weekly: '' } };
    const data = await this.notifyService.digest(
      userId,
      query.module || 'knowledge',
      query.weekly === '1'
    );
    return { success: true, data };
  }
}
