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
} from '../dto/article';
import { createHash } from 'crypto';

@Provide()
export class ArticleHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  articleService: ArticleService;

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
    const userId = this.ctx.userInfo.userId;
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
    const userId = this.ctx.userInfo.userId;
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
    const userId = this.ctx.userInfo.userId;
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
    const userId = this.ctx.userInfo.userId;
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
    const userId = this.ctx.userInfo.userId;
    const data = await this.articleService.getUserBookmarks(
      userId,
      query.module,
      query.page,
      query.pageSize
    );
    return { success: true, data };
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
    const userId = this.ctx.userInfo?.userId;
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
}
