import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { RedisService } from '@midwayjs/redis';
import { In, Repository } from 'typeorm';
import { NavConfigEntity } from '../../entity/navConfig';
import { ArticleEntity } from '../../entity/article';
import { UserArticleActionEntity } from '../../entity/userArticleAction';
import { ArticleViewLogEntity } from '../../entity/articleViewLog';
import { R } from '../../common/base.error.utils';

@Provide()
export class ArticleService {
  @InjectEntityModel(NavConfigEntity)
  navConfigModel: Repository<NavConfigEntity>;

  @InjectEntityModel(ArticleEntity)
  articleModel: Repository<ArticleEntity>;

  @InjectEntityModel(UserArticleActionEntity)
  userArticleActionModel: Repository<UserArticleActionEntity>;

  @InjectEntityModel(ArticleViewLogEntity)
  viewLogModel: Repository<ArticleViewLogEntity>;

  @Inject()
  redisService: RedisService;

  async getNavList(module: string) {
    const config = await this.navConfigModel.findOneBy({ module });
    if (!config) throw R.error(`模块 ${module} 的导航配置不存在`);
    return { navData: config.navData, version: config.version };
  }

  async getArticleStats(articleKey: string) {
    const article = await this.articleModel.findOneBy({ articleKey });
    return {
      likeCount: article?.likeCount || 0,
      bookmarkCount: article?.bookmarkCount || 0,
      shareCount: article?.shareCount || 0,
      viewCount: article?.viewCount || 0,
    };
  }

  async recordView(
    fingerprint: string,
    ip: string,
    userAgent: string,
    articleKey: string,
    module: string,
    title?: string
  ) {
    const redisKey = `view:${fingerprint}:${articleKey}`;
    const existing = await this.redisService.get(redisKey);
    const article = await this.ensureArticle(articleKey, module, title);

    if (!existing) {
      article.viewCount += 1;
      await this.articleModel.save(article);

      const viewDate = new Date().toISOString().split('T')[0];
      await this.viewLogModel.save({
        articleKey,
        module,
        fingerprint,
        viewDate,
        ip,
        userAgent: userAgent.substring(0, 500),
      });

      await this.redisService.set(redisKey, '1', 'EX', 3600);
    }

    return { viewCount: article.viewCount };
  }

  async batchGetArticleStats(articleKeys: string[]) {
    if (!articleKeys.length) return {};
    const articles = await this.articleModel.find({
      where: { articleKey: In(articleKeys) },
    });
    const statsMap: Record<
      string,
      { likeCount: number; bookmarkCount: number; shareCount: number; viewCount: number }
    > = {};
    for (const key of articleKeys) {
      const article = articles.find(a => a.articleKey === key);
      statsMap[key] = {
        likeCount: article?.likeCount || 0,
        bookmarkCount: article?.bookmarkCount || 0,
        shareCount: article?.shareCount || 0,
        viewCount: article?.viewCount || 0,
      };
    }
    return statsMap;
  }

  private async ensureArticle(
    articleKey: string,
    module: string,
    title?: string
  ): Promise<ArticleEntity> {
    let article = await this.articleModel.findOneBy({ articleKey });
    if (!article) {
      article = await this.articleModel.save({
        articleKey,
        module,
        title: title || '',
      });
    } else if (title && !article.title) {
      article.title = title;
      await this.articleModel.save(article);
    }
    return article;
  }

  async toggleLike(
    userId: string,
    articleKey: string,
    module: string,
    title?: string
  ) {
    const article = await this.ensureArticle(articleKey, module, title);

    const existing = await this.userArticleActionModel.findOneBy({
      userId,
      articleKey,
      actionType: 'like',
    });

    if (existing) {
      await this.userArticleActionModel.remove(existing);
      article.likeCount = Math.max(0, article.likeCount - 1);
      await this.articleModel.save(article);
      return { isLiked: false, likeCount: article.likeCount };
    } else {
      await this.userArticleActionModel.save({
        userId,
        articleKey,
        module,
        actionType: 'like',
      });
      article.likeCount += 1;
      await this.articleModel.save(article);
      return { isLiked: true, likeCount: article.likeCount };
    }
  }

  async toggleBookmark(
    userId: string,
    articleKey: string,
    module: string,
    title?: string
  ) {
    const article = await this.ensureArticle(articleKey, module, title);

    const existing = await this.userArticleActionModel.findOneBy({
      userId,
      articleKey,
      actionType: 'bookmark',
    });

    if (existing) {
      await this.userArticleActionModel.remove(existing);
      article.bookmarkCount = Math.max(0, article.bookmarkCount - 1);
      await this.articleModel.save(article);
      return { isBookmarked: false, bookmarkCount: article.bookmarkCount };
    } else {
      await this.userArticleActionModel.save({
        userId,
        articleKey,
        module,
        actionType: 'bookmark',
      });
      article.bookmarkCount += 1;
      await this.articleModel.save(article);
      return { isBookmarked: true, bookmarkCount: article.bookmarkCount };
    }
  }

  async recordShare(articleKey: string, module: string, title?: string) {
    const article = await this.ensureArticle(articleKey, module, title);
    article.shareCount += 1;
    await this.articleModel.save(article);
    return { shareCount: article.shareCount };
  }

  async getUserActions(userId: string, articleKey: string) {
    const actions = await this.userArticleActionModel.findBy({
      userId,
      articleKey,
    });
    return {
      isLiked: actions.some(a => a.actionType === 'like'),
      isBookmarked: actions.some(a => a.actionType === 'bookmark'),
    };
  }

  async getUserLikes(userId: string, module?: string, page = 1, pageSize = 20) {
    const qb = this.userArticleActionModel
      .createQueryBuilder('action')
      .where('action.userId = :userId', { userId })
      .andWhere('action.actionType = :actionType', { actionType: 'like' });

    if (module) {
      qb.andWhere('action.module = :module', { module });
    }

    const total = await qb.getCount();
    const list = await qb
      .leftJoinAndMapOne(
        'action.article',
        ArticleEntity,
        'article',
        'article.articleKey = action.articleKey'
      )
      .orderBy('action.createTime', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    return {
      list: list.map(item => ({
        articleKey: item.articleKey,
        module: item.module,
        title: (item as any).article?.title || '',
        createTime: item.createTime,
      })),
      total,
    };
  }

  async getUserBookmarks(
    userId: string,
    module?: string,
    page = 1,
    pageSize = 20
  ) {
    const qb = this.userArticleActionModel
      .createQueryBuilder('action')
      .where('action.userId = :userId', { userId })
      .andWhere('action.actionType = :actionType', { actionType: 'bookmark' });

    if (module) {
      qb.andWhere('action.module = :module', { module });
    }

    const total = await qb.getCount();
    const list = await qb
      .leftJoinAndMapOne(
        'action.article',
        ArticleEntity,
        'article',
        'article.articleKey = action.articleKey'
      )
      .orderBy('action.createTime', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    return {
      list: list.map(item => ({
        articleKey: item.articleKey,
        module: item.module,
        title: (item as any).article?.title || '',
        createTime: item.createTime,
      })),
      total,
    };
  }
}
