import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { RedisService } from '@midwayjs/redis';
import { In, Repository } from 'typeorm';
import { NavConfigEntity } from '../../entity/navConfig';
import { ArticleEntity } from '../../entity/article';
import { UserArticleActionEntity } from '../../entity/userArticleAction';
import { ArticleViewLogEntity } from '../../entity/articleViewLog';
import { UserEntity } from '../../entity/user';
import { ArticleReadingStateEntity } from '../../entity/articleReadingState';
import { R } from '../../common/base.error.utils';
import { buildProfile, Profile } from './learnerProfile';
import { mergeMastery, Mastery } from '../quiz/grading';

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

  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @InjectEntityModel(ArticleReadingStateEntity)
  readingStateModel: Repository<ArticleReadingStateEntity>;

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

  /**
   * 学习榜（本月）：按「本月在该模块读过的不同文章数」给登录用户排名。
   * 数据源复用 article_view_log（fingerprint 对登录用户即 userId/手机号），
   * inner join user 过滤游客；隐私：不外泄他人手机号，仅回昵称/头像/名次 + isMe。
   */
  async getLeaderboard(module: string, userId?: string) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, '0')}-01`;

    const rows: Array<{ userId: string; cnt: string }> = await this.viewLogModel
      .createQueryBuilder('v')
      .select('v.fingerprint', 'userId')
      .addSelect('COUNT(DISTINCT v.articleKey)', 'cnt')
      .innerJoin(UserEntity, 'u', 'u.phoneNumber = v.fingerprint')
      .where('v.module = :module', { module })
      .andWhere('v.viewDate >= :monthStart', { monthStart })
      .groupBy('v.fingerprint')
      .orderBy('cnt', 'DESC')
      .limit(100)
      .getRawMany();

    const ids = rows.map(r => r.userId);
    const users = ids.length
      ? await this.userModel.find({ where: { phoneNumber: In(ids) } })
      : [];
    const uMap = new Map(users.map(u => [u.phoneNumber, u]));

    const ranked = rows.map((r, i) => ({
      rank: i + 1,
      nickName: uMap.get(r.userId)?.nickName || '匿名用户',
      avatar: uMap.get(r.userId)?.avatar || '',
      count: Number(r.cnt),
      isMe: !!userId && r.userId === userId,
    }));

    const top = ranked.slice(0, 20);

    // 我的名次：在前 100 内直接取；否则单独算我的本月已读数（名次记为 null=未上榜）
    let me: { rank: number | null; count: number } = { rank: null, count: 0 };
    if (userId) {
      const mine = ranked.find(r => r.isMe);
      if (mine) {
        me = { rank: mine.rank, count: mine.count };
      } else {
        const my = await this.viewLogModel
          .createQueryBuilder('v')
          .select('COUNT(DISTINCT v.articleKey)', 'cnt')
          .where('v.module = :module', { module })
          .andWhere('v.viewDate >= :monthStart', { monthStart })
          .andWhere('v.fingerprint = :userId', { userId })
          .getRawOne();
        me = { rank: null, count: Number(my?.cnt || 0) };
      }
    }

    return { period: 'month', top, me };
  }

  async upsertReadingState(p: {
    userId: string; module: string; articleKey: string;
    status: string; mastery?: string; lastReadAt: number;
  }): Promise<void> {
    const existing = await this.readingStateModel.findOne({
      where: { userId: p.userId, module: p.module, articleKey: p.articleKey },
    });
    if (existing) {
      // 只在更新更晚时覆盖,避免乱序写回退状态
      if (p.lastReadAt >= Number(existing.lastReadAt)) {
        existing.status = p.status;
        if (p.mastery) existing.mastery = p.mastery;
        existing.lastReadAt = p.lastReadAt;
        await this.readingStateModel.save(existing);
      }
    } else {
      await this.readingStateModel.save({
        userId: p.userId, module: p.module, articleKey: p.articleKey,
        status: p.status, mastery: p.mastery, lastReadAt: p.lastReadAt,
      });
    }
  }

  /**
   * 掌握度回流（PRD-01 F1-2）。读现状 → 合并 → 写回。
   * mode='authoritative' 本人重新测验可升可降；'atLeast' 旁路信号只升不降。
   * 不存在记录时按「已读」建档（lastReadAt=now）。
   */
  async reflowMastery(
    userId: string,
    module: string,
    articleKey: string,
    target: Mastery,
    mode: 'atLeast' | 'authoritative' = 'authoritative'
  ): Promise<{ from?: string; to: Mastery }> {
    const existing = await this.readingStateModel.findOne({
      where: { userId, module, articleKey },
    });
    const from = existing?.mastery as Mastery | undefined;
    const to = mergeMastery(from, target, mode);
    if (existing) {
      existing.mastery = to;
      if (existing.status !== 'done') existing.status = 'done';
      await this.readingStateModel.save(existing);
    } else {
      await this.readingStateModel.save({
        userId,
        module,
        articleKey,
        status: 'done',
        mastery: to,
        lastReadAt: Date.now(),
      });
    }
    await this.redisService.del(`profile:${userId}:${module}`);
    return { from, to };
  }

  /** 给 AI 判分/建议用的画像摘要（会员个性化）。 */
  async getProfileSummary(userId: string, module: string): Promise<string> {
    try {
      const p = await this.getLearnerProfile(userId, module);
      const cov = p.coverage;
      return `已学 ${cov.done}/${cov.total} 篇(覆盖率 ${Math.round(
        cov.ratio * 100
      )}%)，最近在看 ${p.recentKeys.slice(0, 3).join('、') || '无'}，待复习 ${
        p.reviewDue.length
      } 篇。`;
    } catch {
      return '';
    }
  }

  async listReadingState(userId: string, module: string) {
    const rows = await this.readingStateModel.find({
      where: { userId, module },
      order: { lastReadAt: 'DESC' },
    });
    return rows.map(r => ({
      articleKey: r.articleKey,
      status: r.status,
      mastery: r.mastery || undefined,
      lastReadAt: Number(r.lastReadAt),
    }));
  }

  async getLearnerProfile(userId: string, module: string): Promise<Profile> {
    const cacheKey = `profile:${userId}:${module}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) return JSON.parse(cached) as Profile;

    const reading = await this.listReadingState(userId, module);

    // 拍平叶子节点求 totalArticles
    let totalArticles = 0;
    try {
      const { navData } = await this.getNavList(module);
      const flattenLeaves = (nodes: any[]): number => {
        if (!Array.isArray(nodes)) return 0;
        let count = 0;
        for (const node of nodes) {
          if (node.isLeaf === true) count += 1;
          if (Array.isArray(node.children) && node.children.length) {
            count += flattenLeaves(node.children);
          }
        }
        return count;
      };
      totalArticles = flattenLeaves(navData || []);
    } catch {
      // navData 不存在时不影响画像其余字段
      totalArticles = 0;
    }

    const profile = buildProfile({ reading, totalArticles, now: Date.now() });
    await this.redisService.set(cacheKey, JSON.stringify(profile), 'EX', 60);
    return profile;
  }
}
