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
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { NoAuth } from '../decorator/noAuth';
import { resolveUserInfo } from '../common/admin.guard';
import { EntitlementService } from '../service/entitlement';
import { ArticleService } from '../service/article';
import { ArticleContentEntity } from '../entity/articleContent';
import { navIndex } from '../mcp/tools/agent';
import {
  aggregateTopics,
  ArticleQuestions,
  buildQuestionIndex,
  FREE_TOPIC_LIMIT,
  sanitizeKeys,
} from '../common/interviewTopics';

/** 进程内缓存：题目索引按目录版本失效，最长 10 分钟。 */
const INDEX_TTL_MS = 10 * 60 * 1000;
let cached: {
  version: string;
  at: number;
  index: ArticleQuestions[];
  knowledge: Map<string, { title: string; path: string }>;
} | null = null;

/**
 * 网站「高频考点榜」：在用户当前筛出来的那批面经里，按考点统计出现篇数并附原题。
 * 会员权益（2026-11-01 owner 定）：面经正文免费；完整榜单与每个考点的全部原题给会员，
 * 未开通只看前 FREE_TOPIC_LIMIT 条的原题，其余只给考点名、篇数和公司。
 */
@Provide()
export class InterviewTopicsHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  entitlementService: EntitlementService;

  @Inject()
  articleService: ArticleService;

  @InjectEntityModel(ArticleContentEntity)
  contentModel: Repository<ArticleContentEntity>;

  private async loadIndex() {
    const [interview, knowledge] = await Promise.all([
      this.articleService.getNavList('interview'),
      this.articleService
        .getNavList('knowledge')
        .catch(() => ({ navData: [], version: 0 })),
    ]);
    const version = `${interview.version}:${knowledge.version}`;
    if (
      cached &&
      cached.version === version &&
      Date.now() - cached.at < INDEX_TTL_MS
    )
      return cached;
    const rows = await this.contentModel.find({
      where: { module: 'interview' },
      select: ['articleKey', 'content'],
    });
    const contents = new Map<string, string>(
      rows.map(r => [r.articleKey, r.content || ''])
    );
    cached = {
      version,
      at: Date.now(),
      index: buildQuestionIndex(interview.navData || [], contents),
      knowledge: navIndex(knowledge.navData || []),
    };
    return cached;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '面经高频考点榜（按当前筛选的那批面经统计；会员看全部原题）',
    functionName: 'interviewTopics',
    name: 'interviewTopics',
    path: '/interview/topics',
    method: 'post',
  })
  @NoAuth()
  async topics(@Body(ALL) body: { keys?: unknown; limit?: number }) {
    const keys = sanitizeKeys(body?.keys);
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId =
      info?.userId && !String(info.userId).startsWith('guest:')
        ? String(info.userId)
        : '';
    const unlocked = userId
      ? (await this.entitlementService.check(userId, 'interview_topics_full'))
          .allowed
      : false;
    const { index, knowledge } = await this.loadIndex();
    const result = aggregateTopics(index, {
      keys,
      knowledgeTitles: knowledge,
      unlocked,
      limit: Number(body?.limit) || undefined,
    });
    return {
      success: true,
      data: {
        ...result,
        unlocked,
        needsLogin: !userId,
        freeLimit: FREE_TOPIC_LIMIT,
      },
    };
  }
}
