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
import { ArticleService } from '../service/article';
import { NoAuth } from '../decorator/noAuth';
import {
  NavListQueryDTO,
  ArticleActionDTO,
  ArticleStatsQueryDTO,
  UserActionsQueryDTO,
  UserActionListQueryDTO,
  RecordViewDTO,
  BatchArticleStatsQueryDTO,
  LeaderboardQueryDTO,
  ReadingStateQueryDTO,
  ReadingStateBodyDTO,
} from '../dto/article';
import { createHash } from 'crypto';
import { EntitlementService } from '../service/entitlement';
import {
  QUOTA_MODULES,
  READING_QUOTA,
  decideReading,
} from '../common/readingQuota';

@Provide()
export class ArticleHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  articleService: ArticleService;

  @Inject()
  redisService: RedisService;

  @Inject()
  entitlementService: EntitlementService;

  /** @NoAuth 路由不过鉴权中间件，这里按需手动从 token 解析登录用户（用于浏览归因/学习榜）。 */
  private async resolveUserId(): Promise<string | undefined> {
    const fromCtx = (this.ctx as any).userInfo?.userId as string | undefined;
    if (fromCtx) return fromCtx;
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

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取模块导航列表',
    functionName: 'getNavList',
    name: 'getNavList',
    path: '/article/navList',
    method: 'get',
  })
  @NoAuth()
  async getNavList(@Query(ALL) query: NavListQueryDTO) {
    const data = await this.articleService.getNavList(query.module);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取文章互动统计',
    functionName: 'getArticleStats',
    name: 'getArticleStats',
    path: '/article/stats',
    method: 'get',
  })
  @NoAuth()
  async getArticleStats(@Query(ALL) query: ArticleStatsQueryDTO) {
    const data = await this.articleService.getArticleStats(query.articleKey);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '点赞/取消点赞',
    functionName: 'toggleLike',
    name: 'toggleLike',
    path: '/article/like',
    method: 'post',
  })
  async toggleLike(@Body(ALL) body: ArticleActionDTO) {
    const userId = body.userId || this.ctx.userInfo?.userId;
    const data = await this.articleService.toggleLike(
      userId,
      body.articleKey,
      body.module,
      body.title
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '收藏/取消收藏',
    functionName: 'toggleBookmark',
    name: 'toggleBookmark',
    path: '/article/bookmark',
    method: 'post',
  })
  async toggleBookmark(@Body(ALL) body: ArticleActionDTO) {
    const userId = body.userId || this.ctx.userInfo?.userId;
    const data = await this.articleService.toggleBookmark(
      userId,
      body.articleKey,
      body.module,
      body.title
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '记录分享',
    functionName: 'recordShare',
    name: 'recordShare',
    path: '/article/share',
    method: 'post',
  })
  @NoAuth()
  async recordShare(@Body(ALL) body: ArticleActionDTO) {
    const data = await this.articleService.recordShare(
      body.articleKey,
      body.module,
      body.title
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取用户对某篇文章的互动状态',
    functionName: 'getUserActions',
    name: 'getUserActions',
    path: '/article/userActions',
    method: 'get',
  })
  async getUserActions(@Query(ALL) query: UserActionsQueryDTO) {
    const userId = query.userId || this.ctx.userInfo?.userId;
    const data = await this.articleService.getUserActions(
      userId,
      query.articleKey
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取用户点赞的所有文章',
    functionName: 'getUserLikes',
    name: 'getUserLikes',
    path: '/article/userLikes',
    method: 'get',
  })
  async getUserLikes(@Query(ALL) query: UserActionListQueryDTO) {
    const userId = query.userId || this.ctx.userInfo?.userId;
    const data = await this.articleService.getUserLikes(
      userId,
      query.module,
      query.page,
      query.pageSize
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取用户收藏的所有文章',
    functionName: 'getUserBookmarks',
    name: 'getUserBookmarks',
    path: '/article/userBookmarks',
    method: 'get',
  })
  async getUserBookmarks(@Query(ALL) query: UserActionListQueryDTO) {
    const userId = query.userId || this.ctx.userInfo?.userId;
    const data = await this.articleService.getUserBookmarks(
      userId,
      query.module,
      query.page,
      query.pageSize
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '非会员阅读额度：能否打开这篇正文（登录非会员每模块 5 篇，终身）',
    functionName: 'articleAccess',
    name: 'articleAccess',
    path: '/article/access',
    method: 'post',
  })
  @NoAuth()
  async articleAccess(@Body(ALL) body: RecordViewDTO) {
    const userId = await this.resolveUserId();
    const module = body.module;
    // 游客由前端本机计数（3 篇）；这里只负责登录用户
    if (!userId) {
      return {
        success: true,
        data: { allowed: true, guest: true, quota: READING_QUOTA.guest },
      };
    }
    if (!(QUOTA_MODULES as readonly string[]).includes(module)) {
      return { success: true, data: { allowed: true, unlimited: true } };
    }
    try {
      if (await this.entitlementService.isMember(userId)) {
        return { success: true, data: { allowed: true, member: true } };
      }
      const keys = await this.articleService.readArticleKeys(userId, module);
      const d = decideReading(keys, body.articleKey, READING_QUOTA.login);
      if (d.allowed && d.consumes) {
        // 立即记一笔浏览，额度以库为准，防止连开多篇时都还没记上
        const ip =
          this.ctx.get('x-forwarded-for')?.split(',')[0]?.trim() ||
          this.ctx.ip ||
          '';
        const ua = this.ctx.get('user-agent') || '';
        if (module === 'algorithm') {
          // 算法题不是文章：只记一笔浏览日志用于计数，不建 article 行、不涨阅读数
          await this.articleService.logQuotaView(userId, ip, ua, body.articleKey, module);
        } else {
          await this.articleService.recordView(userId, ip, ua, body.articleKey, module, body.title);
        }
      }
      return {
        success: true,
        data: { allowed: d.allowed, used: d.used, quota: d.quota },
      };
    } catch {
      // 判定失败放行：宁可多给一篇，也不能因为后端抖动把读者挡在门外
      return { success: true, data: { allowed: true, degraded: true } };
    }
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '记录文章浏览',
    functionName: 'recordArticleView',
    name: 'recordArticleView',
    path: '/article/view',
    method: 'post',
  })
  @NoAuth()
  async recordArticleView(@Body(ALL) body: RecordViewDTO) {
    const userId = await this.resolveUserId();
    const ip =
      this.ctx.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      this.ctx.ip ||
      '';
    const ua = this.ctx.get('user-agent') || '';
    const fingerprint =
      userId ||
      createHash('md5')
        .update(ip + ua)
        .digest('hex');
    const data = await this.articleService.recordView(
      fingerprint,
      ip,
      ua,
      body.articleKey,
      body.module,
      body.title
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '批量获取文章统计',
    functionName: 'batchArticleStats',
    name: 'batchArticleStats',
    path: '/article/batchStats',
    method: 'get',
  })
  @NoAuth()
  async batchArticleStats(@Query(ALL) query: BatchArticleStatsQueryDTO) {
    const keys = query.articleKeys
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    const data = await this.articleService.batchGetArticleStats(keys);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '学习榜（本月，按已读篇数）',
    functionName: 'getLeaderboard',
    name: 'getLeaderboard',
    path: '/article/leaderboard',
    method: 'get',
  })
  @NoAuth()
  async getLeaderboard(@Query(ALL) query: LeaderboardQueryDTO) {
    const data = await this.articleService.getLeaderboard(
      query.module,
      query.userId
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '查询学习状态',
    functionName: 'getReadingState',
    name: 'getReadingState',
    path: '/article/readingState',
    method: 'get',
  })
  @NoAuth()
  async getReadingState(@Query(ALL) query: ReadingStateQueryDTO) {
    const userId = (await this.resolveUserId()) || query.userId || '';
    if (!userId) return { success: true, data: { list: [] } };
    const list = await this.articleService.listReadingState(userId, query.module);
    return { success: true, data: { list } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '上报学习状态',
    functionName: 'postReadingState',
    name: 'postReadingState',
    path: '/article/readingState',
    method: 'post',
  })
  @NoAuth()
  async postReadingState(@Body(ALL) body: ReadingStateBodyDTO) {
    const userId = (await this.resolveUserId()) || body.userId || '';
    if (!userId) return { success: true, data: {} };
    await this.articleService.upsertReadingState({
      userId,
      module: body.module,
      articleKey: body.articleKey,
      status: body.status,
      mastery: body.mastery,
      lastReadAt: body.lastReadAt || Date.now(),
    });
    return { success: true, data: {} };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '学习者画像（覆盖率/近期/复习/兴趣/连续天数）',
    functionName: 'getLearnerProfile',
    name: 'getLearnerProfile',
    path: '/article/learnerProfile',
    method: 'get',
  })
  @NoAuth()
  async getLearnerProfile(@Query(ALL) query: ReadingStateQueryDTO) {
    const userId = (await this.resolveUserId()) || query.userId || '';
    if (!userId) {
      return {
        success: true,
        data: { coverage: { done: 0, total: 0, ratio: 0 }, recentKeys: [], reviewDue: [], interests: [], streak: 0 },
      };
    }
    const data = await this.articleService.getLearnerProfile(userId, query.module);
    return { success: true, data };
  }
}
