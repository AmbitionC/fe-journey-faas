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
import { R } from '../common/base.error.utils';
import { resolveUserInfo } from '../common/admin.guard';
import {
  KidsProgress,
  mergeProgress,
  profileKey,
  progressKey,
  sanitizeProfile,
  sanitizeProgress,
} from '../service/kids/state';

/**
 * 栗栗学英语（little-circle-web）：登录后同步孩子的学习计划和阅读进度。
 * 账号就是主站账号（手机号），只认登录态身份，不接受 body 里的 userId。
 */
@Provide()
export class KidsHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  private async requireUser(): Promise<string> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    if (!info?.userId) throw R.unauthorizedError('请先登录');
    return info.userId;
  }

  private async readProgress(userId: string): Promise<KidsProgress> {
    const raw = await this.redisService.get(progressKey(userId));
    try {
      return raw ? sanitizeProgress(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '栗栗学英语：读取孩子的计划和进度',
    functionName: 'kidsState',
    name: 'kidsState',
    path: '/kids/state',
    method: 'get',
  })
  async state() {
    const userId = await this.requireUser();
    const raw = await this.redisService.get(profileKey(userId));
    let profile = null;
    try {
      profile = raw ? sanitizeProfile(JSON.parse(raw)) : null;
    } catch {
      profile = null;
    }
    return {
      success: true,
      data: { profile, progress: await this.readProgress(userId) },
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '栗栗学英语：保存孩子的计划',
    functionName: 'kidsSaveProfile',
    name: 'kidsSaveProfile',
    path: '/kids/profile',
    method: 'post',
  })
  async saveProfile(@Body(ALL) body: unknown) {
    const userId = await this.requireUser();
    const profile = sanitizeProfile(body);
    if (!profile) throw R.validateError('计划信息不完整');
    await this.redisService.set(profileKey(userId), JSON.stringify(profile));
    return { success: true, data: profile };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '栗栗学英语：合并保存阅读进度（两边取并集）',
    functionName: 'kidsSaveProgress',
    name: 'kidsSaveProgress',
    path: '/kids/progress',
    method: 'post',
  })
  async saveProgress(@Body(ALL) body: unknown) {
    const userId = await this.requireUser();
    const merged = mergeProgress(
      await this.readProgress(userId),
      sanitizeProgress(body)
    );
    await this.redisService.set(progressKey(userId), JSON.stringify(merged));
    return { success: true, data: merged };
  }
}
