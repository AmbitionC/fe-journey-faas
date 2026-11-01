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
  buildSheet,
  decideSheetQuota,
  FREE_TOPIC_LIMIT,
  leafKeysUnder,
  sanitizeKeys,
  sheetSignature,
} from '../common/interviewTopics';

/** 未开通会员每月可导出的题单份数（同一批面经重复打开不再扣）。 */
const FREE_SHEETS_PER_MONTH = 1;
const SHEET_QUOTA_TTL = 40 * 24 * 60 * 60;

/** 北京时间的年月，作为免费额度的计数周期。 */
function beijingMonth(now = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function sanitizeTitle(raw: unknown): string {
  return typeof raw === 'string'
    ? raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60)
    : '';
}

/** 进程内缓存：题目索引按目录版本失效，最长 10 分钟。 */
const INDEX_TTL_MS = 10 * 60 * 1000;
let cached: {
  version: string;
  at: number;
  index: ArticleQuestions[];
  knowledge: Map<string, { title: string; path: string }>;
  careerKeys: Set<string>;
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
      careerKeys: leafKeysUnder(knowledge.navData || [], 'career'),
    };
    return cached;
  }

  private async currentUserId(): Promise<string> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    return info?.userId && !String(info.userId).startsWith('guest:')
      ? String(info.userId)
      : '';
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
    const userId = await this.currentUserId();
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

  /**
   * 题单：把当前筛出来的那批面经里的全部题按考点归组，附第一段答题思路，前端排版后存成 PDF。
   * 会员不限；未开通每月 1 份（先返回 needsConfirm，前端确认后带 confirm 再领），
   * 同一批面经重复打开不再扣；未登录需先登录。
   */
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '面经题单（按当前筛选的那批面经出全部题与答题要点；会员不限，未开通每月 1 份）',
    functionName: 'interviewSheet',
    name: 'interviewSheet',
    path: '/interview/sheet',
    method: 'post',
  })
  @NoAuth()
  async sheet(
    @Body(ALL) body: { keys?: unknown; title?: unknown; confirm?: boolean }
  ) {
    const keys = sanitizeKeys(body?.keys);
    const title = sanitizeTitle(body?.title);
    const userId = await this.currentUserId();
    if (!userId) return { success: true, data: { needsLogin: true } };

    const member = (
      await this.entitlementService.check(userId, 'interview_sheet')
    ).allowed;
    const { index, knowledge, careerKeys } = await this.loadIndex();
    const sheet = buildSheet(index, {
      keys,
      knowledgeTitles: knowledge,
      lastKeys: careerKeys,
    });
    const base = { member, freeLimit: FREE_SHEETS_PER_MONTH, title };
    if (member || !sheet.totalQuestions)
      return { success: true, data: { ...base, ...sheet } };

    const quotaKey = `interview_sheet:${beijingMonth()}:${userId}`;
    const sig = sheetSignature(keys);
    const readUsed = async (): Promise<{ sig?: string; title?: string } | null> => {
      const raw = await this.redisService.get(quotaKey);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return { sig: raw };
      }
    };
    let used = await readUsed();
    let decision = decideSheetQuota(used, sig, !!body?.confirm);
    if (decision === 'needsConfirm')
      return { success: true, data: { ...base, needsConfirm: true } };
    if (decision === 'claim') {
      const claimed = await this.redisService.set(
        quotaKey,
        JSON.stringify({ sig, title }),
        'EX',
        SHEET_QUOTA_TTL,
        'NX'
      );
      // 并发下别的请求先领了：按它领到的那份重新判定
      used = claimed ? { sig, title } : await readUsed();
      decision = decideSheetQuota(used, sig, false);
    }
    if (decision !== 'ok')
      return {
        success: true,
        data: { ...base, locked: true, usedTitle: used?.title || '' },
      };
    return { success: true, data: { ...base, ...sheet, freeUsed: true } };
  }
}
