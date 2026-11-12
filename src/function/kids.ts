import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
  Query,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { R } from '../common/base.error.utils';
import { resolveUserInfo } from '../common/admin.guard';
import {
  KidsProgress,
  KidsReading,
  mergeProgress,
  mergeReading,
  profileKey,
  progressKey,
  readingKey,
  sanitizeProfile,
  sanitizeProgress,
  sanitizeReading,
} from '../service/kids/state';
import { OssService } from '../service/content/oss';
import { clientIpFromCtx } from '../common/clientIp';
import {
  ORT_SHELF_KEY,
  ORT_SIGN_SECONDS,
  ortBookId,
  ortObjectKey,
  signOrtBook,
  signOrtShelf,
  toHttps,
} from '../service/kids/ort';

/** 牛津树签名接口不要求登录（没登录也能读书），按 IP 限流：10 分钟 300 次 */
const ORT_RATE = { limit: 300, ttl: 600 };

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

  @Inject()
  ossService: OssService;

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

  private async readReading(userId: string): Promise<KidsReading> {
    const raw = await this.redisService.get(readingKey(userId));
    try {
      return sanitizeReading(raw ? JSON.parse(raw) : null);
    } catch {
      return sanitizeReading(null);
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
      data: {
        profile,
        progress: await this.readProgress(userId),
        reading: await this.readReading(userId),
      },
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

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '栗栗学英语：合并保存阅读状态（读到哪页、读完几次、偏好）',
    functionName: 'kidsSaveReading',
    name: 'kidsSaveReading',
    path: '/kids/reading',
    method: 'post',
  })
  async saveReading(@Body(ALL) body: unknown) {
    const userId = await this.requireUser();
    const merged = mergeReading(
      await this.readReading(userId),
      sanitizeReading(body)
    );
    await this.redisService.set(readingKey(userId), JSON.stringify(merged));
    return { success: true, data: merged };
  }

  /** 同一个 IP 10 分钟最多 300 次；Redis 出问题时放行，不影响读书 */
  private async ortRateLimit() {
    const ip = clientIpFromCtx(this.ctx);
    if (!ip) return;
    const key = `kids:ort:rate:${Math.floor(
      Date.now() / 1000 / ORT_RATE.ttl
    )}:${ip}`;
    let n = 0;
    try {
      n = await this.redisService.incr(key);
      if (n === 1) await this.redisService.expire(key, ORT_RATE.ttl);
    } catch {
      return;
    }
    if (n > ORT_RATE.limit) throw R.validateError('请求太频繁，稍后再试');
  }

  private ortSign = (objectKey: string) =>
    toHttps(this.ossService.signedUrl(objectKey, ORT_SIGN_SECONDS));

  private async ortJson(objectKey: string): Promise<unknown> {
    const text = await this.ossService.getRawText(objectKey);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '栗栗学英语：牛津树书目（封面是 2 小时签名地址）',
    functionName: 'kidsOrtShelf',
    name: 'kidsOrtShelf',
    path: '/kids/ort/shelf',
    method: 'get',
  })
  async ortShelf() {
    await this.ortRateLimit();
    const shelf = await this.ortJson(ORT_SHELF_KEY);
    return { success: true, data: signOrtShelf(shelf, this.ortSign) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description:
      '栗栗学英语：牛津树一本书（每页图、每句音频都是 2 小时签名地址）',
    functionName: 'kidsOrtBook',
    name: 'kidsOrtBook',
    path: '/kids/ort/book',
    method: 'get',
  })
  async ortBook(@Query('id') id: string) {
    await this.ortRateLimit();
    const bookId = ortBookId(id);
    if (!bookId) throw R.validateError('书号不对');
    const book = await this.ortJson(
      ortObjectKey(bookId, 'book.json') as string
    );
    if (!book || typeof book !== 'object') throw R.error('这本书找不到了');
    return {
      success: true,
      data: signOrtBook(bookId, book as Record<string, unknown>, this.ortSign),
    };
  }
}
