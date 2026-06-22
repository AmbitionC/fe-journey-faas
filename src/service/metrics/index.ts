import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user';
import { ArticleReadingStateEntity } from '../../entity/articleReadingState';
import { QuizAttemptEntity } from '../../entity/quizAttempt';
import { AiUsageLogEntity } from '../../entity/aiUsageLog';
import { AiCallLogEntity } from '../../entity/aiCallLog';
import { EventLogEntity } from '../../entity/eventLog';

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

  async track(p: { userId?: string; event: string; props?: any; ua?: string; ip?: string }) {
    try {
      await this.eventLogModel.save(
        this.eventLogModel.create({
          userId: p.userId,
          event: p.event,
          props: p.props ?? null,
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
  async overview() {
    const [users, readingDone, quizAttempts, aiCalls] = await Promise.all([
      this.userModel.count(),
      this.readingStateModel.count({ where: { status: 'done' } }),
      this.quizAttemptModel.count(),
      this.aiUsageLogModel.count(),
    ]);

    let members = 0;
    try {
      members = await this.userModel.count({ where: { isMember: true } as any });
    } catch {
      members = 0;
    }

    // 平均测验分 + 完成测验的去重用户数
    let avgScore = 0;
    let quizUsers = 0;
    try {
      const row = await this.quizAttemptModel
        .createQueryBuilder('a')
        .select('AVG(a.score)', 'avg')
        .addSelect('COUNT(DISTINCT a.userId)', 'users')
        .getRawOne();
      avgScore = Math.round(Number(row?.avg || 0));
      quizUsers = Number(row?.users || 0);
    } catch {
      /* ignore */
    }

    // AI token 总量
    let tokens = 0;
    try {
      const row = await this.aiUsageLogModel
        .createQueryBuilder('u')
        .select('SUM(u.tokenUsed)', 'sum')
        .getRawOne();
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
