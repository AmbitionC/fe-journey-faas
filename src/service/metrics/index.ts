import { Provide, Inject, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user';
import { ArticleReadingStateEntity } from '../../entity/articleReadingState';
import { QuizAttemptEntity } from '../../entity/quizAttempt';
import { AiUsageLogEntity } from '../../entity/aiUsageLog';
import { AiCallLogEntity } from '../../entity/aiCallLog';
import { EventLogEntity } from '../../entity/eventLog';
import { EvalReportEntity } from '../../entity/evalReport';
import { AiProxyService } from '../ai/proxy';
import { runEval } from '../../eval/runner';

@Provide()
export class MetricsService {
  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @InjectEntityModel(ArticleReadingStateEntity)
  readingStateModel: Repository<ArticleReadingStateEntity>;

  @InjectEntityModel(QuizAttemptEntity)
  quizAttemptModel: Repository<QuizAttemptEntity>;

  @InjectEntityModel(AiUsageLogEntity)
  aiUsageLogModel: Repository<AiUsageLogEntity>;

  @InjectEntityModel(AiCallLogEntity)
  aiCallLogModel: Repository<AiCallLogEntity>;

  @InjectEntityModel(EventLogEntity)
  eventLogModel: Repository<EventLogEntity>;

  @InjectEntityModel(EvalReportEntity)
  evalReportModel: Repository<EvalReportEntity>;

  @Inject()
  aiProxyService: AiProxyService;

  @Config('growthInternalUserIds')
  internalUserIds: string[];

  /** 内部/自测账号排除口径：config（GROWTH_INTERNAL_USER_IDS）∪ 调用方额外传入 */
  private excludedUserIds(extra?: string[]): string[] {
    const merged = [...(this.internalUserIds || []), ...(extra || [])]
      .map((s) => String(s).trim())
      .filter(Boolean);
    return Array.from(new Set(merged));
  }

  /** 在线跑一次评测集并存档（PRD-02 F2-3 → PRD-04）。 */
  async runEval() {
    const report = await runEval((system, user) =>
      this.aiProxyService.completeRaw(system, user, 'eval-bot')
    );
    const saved = await this.evalReportModel.save(
      this.evalReportModel.create({
        metrics: report,
        gradeAccuracy: report.gradeAccuracy.rate,
      })
    );
    return saved;
  }

  async latestEval() {
    const rows = await this.evalReportModel.find({ order: { id: 'DESC' }, take: 1 });
    return rows[0] || null;
  }

  async track(p: {
    userId?: string;
    event: string;
    props?: any;
    channel?: string;
    ua?: string;
    ip?: string;
  }) {
    try {
      await this.eventLogModel.save(
        this.eventLogModel.create({
          userId: p.userId,
          event: p.event,
          props: p.props ?? null,
          channel: p.channel ? String(p.channel).slice(0, 64) : undefined,
          ua: (p.ua || '').slice(0, 256),
          ip: p.ip,
        })
      );
    } catch {
      /* 埋点失败不影响主流程 */
    }
    return { ok: true };
  }

  /** 看板概览（PRD-04 F1-2）。低用量下直接实时聚合。 */
  async overview(exclude?: string[]) {
    const ex = this.excludedUserIds(exclude);

    // 各存量口径统一排除内部/自测账号（userId = 手机号）
    const usersQb = this.userModel.createQueryBuilder('u');
    if (ex.length) usersQb.andWhere('u.phoneNumber NOT IN (:...ex)', { ex });

    const readingQb = this.readingStateModel
      .createQueryBuilder('r')
      .where("r.status = 'done'");
    if (ex.length) readingQb.andWhere('r.userId NOT IN (:...ex)', { ex });

    const quizCountQb = this.quizAttemptModel.createQueryBuilder('a');
    if (ex.length) quizCountQb.andWhere('a.userId NOT IN (:...ex)', { ex });

    const aiCallsQb = this.aiUsageLogModel.createQueryBuilder('u');
    if (ex.length) aiCallsQb.andWhere('u.userId NOT IN (:...ex)', { ex });

    const [users, readingDone, quizAttempts, aiCalls] = await Promise.all([
      usersQb.getCount(),
      readingQb.getCount(),
      quizCountQb.getCount(),
      aiCallsQb.getCount(),
    ]);

    let members = 0;
    try {
      const qb = this.userModel
        .createQueryBuilder('u')
        .where('u.isMember = :m', { m: true });
      if (ex.length) qb.andWhere('u.phoneNumber NOT IN (:...ex)', { ex });
      members = await qb.getCount();
    } catch {
      members = 0;
    }

    // 平均测验分 + 完成测验的去重用户数
    let avgScore = 0;
    let quizUsers = 0;
    try {
      const qb = this.quizAttemptModel
        .createQueryBuilder('a')
        .select('AVG(a.score)', 'avg')
        .addSelect('COUNT(DISTINCT a.userId)', 'users');
      if (ex.length) qb.andWhere('a.userId NOT IN (:...ex)', { ex });
      const row = await qb.getRawOne();
      avgScore = Math.round(Number(row?.avg || 0));
      quizUsers = Number(row?.users || 0);
    } catch {
      /* ignore */
    }

    // AI token 总量
    let tokens = 0;
    try {
      const qb = this.aiUsageLogModel
        .createQueryBuilder('u')
        .select('SUM(u.tokenUsed)', 'sum');
      if (ex.length) qb.andWhere('u.userId NOT IN (:...ex)', { ex });
      const row = await qb.getRawOne();
      tokens = Number(row?.sum || 0);
    } catch {
      /* ignore */
    }

    return {
      users,
      members,
      readingDone,
      quizAttempts,
      quizUsers,
      avgScore,
      aiCalls,
      tokens,
    };
  }

  /** 近 N 天事件计数 Top（PRD-04 F1-1）。 */
  async events(days = 7) {
    const since = new Date(Date.now() - days * 86400000);
    try {
      const rows = await this.eventLogModel
        .createQueryBuilder('e')
        .select('e.event', 'event')
        .addSelect('COUNT(*)', 'count')
        .where('e.createTime >= :since', { since })
        .groupBy('e.event')
        .orderBy('count', 'DESC')
        .limit(30)
        .getRawMany();
      return rows.map((r) => ({ event: r.event, count: Number(r.count) }));
    } catch {
      return [];
    }
  }

  /** AI 调用查询（PRD-04 F2-1）。 */
  async aiCalls(params: { page?: number; pageSize?: number; route?: string; status?: string }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const qb = this.aiCallLogModel.createQueryBuilder('c');
    if (params.route) qb.andWhere('c.route = :route', { route: params.route });
    if (params.status) qb.andWhere('c.status = :status', { status: params.status });
    const total = await qb.getCount();
    const list = await qb
      .orderBy('c.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();
    return { list, total };
  }
}
