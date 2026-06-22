import { Inject, Provide } from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import { QuizQuestionEntity } from '../../entity/quizQuestion';
import {
  OpsTaskEntity,
  OpsAuditLogEntity,
  OpsReviewEntity,
} from '../../entity/ops';
import { QuizService } from '../quiz';
import { AiProxyService } from '../ai/proxy';
import { nextBreaker, BreakerState } from './circuitBreaker';

const WINDOW_MS = 3600_000; // 1 小时
const AUTO_QUIZ_LIMIT = parseInt(process.env.OPS_AUTOQUIZ_LIMIT || '5', 10);
const CONFIDENCE_THRESHOLD = parseFloat(process.env.OPS_CONFIDENCE || '0.7');

/**
 * 自动执行器（PRD-08 全自动 + 自动护栏）。
 * 以「自动出题→AI 审 AI→达标自动发布」为首个自治能力，全程：
 * 异常熔断 + 操作审计 + 可回滚 + 抽检反哺。
 */
@Provide()
export class OpsExecutorService {
  @Inject()
  redisService: RedisService;

  @Inject()
  quizService: QuizService;

  @Inject()
  aiProxyService: AiProxyService;

  @InjectEntityModel(QuizQuestionEntity)
  questionModel: Repository<QuizQuestionEntity>;

  @InjectEntityModel(OpsTaskEntity)
  taskModel: Repository<OpsTaskEntity>;

  @InjectEntityModel(OpsAuditLogEntity)
  auditModel: Repository<OpsAuditLogEntity>;

  @InjectEntityModel(OpsReviewEntity)
  reviewModel: Repository<OpsReviewEntity>;

  /** 熔断检查：Redis 持久滑动窗口计数。 */
  private async checkBreaker(type: string): Promise<{ allowed: boolean; remaining: number }> {
    const key = `ops:breaker:${type}`;
    let prev: BreakerState | null = null;
    try {
      const s = await this.redisService.get(key);
      if (s) prev = JSON.parse(s);
    } catch {
      prev = null;
    }
    const r = nextBreaker(prev, Date.now(), WINDOW_MS, AUTO_QUIZ_LIMIT);
    try {
      await this.redisService.set(key, JSON.stringify(r.state), 'PX', WINDOW_MS);
    } catch {
      /* ignore */
    }
    return { allowed: r.allowed, remaining: r.remaining };
  }

  /**
   * 自动出题并发布：generate → AI 审 → 达标自动发布，否则留草稿。
   */
  async autoQuiz(params: { userId: string; module: string; articleKey: string }) {
    const { userId, module, articleKey } = params;

    // 1) 异常熔断
    const breaker = await this.checkBreaker('autoQuiz');
    if (!breaker.allowed) {
      await this.taskModel.save(
        this.taskModel.create({
          type: 'autoQuiz',
          scope: { module, articleKey },
          status: 'paused',
          result: { reason: 'circuit_breaker', message: '单位时间自动出题次数已达上限，已暂停' },
        })
      );
      throw new Error('已触发熔断：自动出题次数过多，请稍后再试');
    }

    const task = await this.taskModel.save(
      this.taskModel.create({ type: 'autoQuiz', scope: { module, articleKey }, status: 'running' })
    );

    try {
      // 2) 生成
      const gen = await this.quizService.generate({ userId, module, articleKey, count: 3 });
      const ids = (gen.list || []).map((q: any) => Number(q.id));
      await this.auditModel.save(
        this.auditModel.create({
          taskId: Number(task.id),
          action: 'generate',
          target: `${module}/${articleKey}`,
          afterSnapshot: { ids },
          rollbackRef: ids.join(','),
          status: 'success',
        })
      );

      // 3) AI 审 AI
      const review = await this.aiProxyService.reviewQuiz(
        {
          title: articleKey,
          questions: (gen.list || []).map((q: any) => ({
            type: q.type,
            stem: q.stem,
            answer: q.answer,
            analysis: q.analysis,
          })),
        },
        userId
      );
      await this.reviewModel.save(
        this.reviewModel.create({
          taskId: Number(task.id),
          reviewerModel: process.env.LLM_MODEL || 'deepseek-chat',
          verdict: review.verdict,
          confidence: review.confidence,
          issues: review.issues,
        })
      );

      // 4) 达标自动发布，否则留草稿
      let published = 0;
      if (review.verdict === 'pass' && review.confidence >= CONFIDENCE_THRESHOLD && ids.length) {
        await this.questionModel.update({ id: In(ids.map(String)) }, { status: 'published' });
        published = ids.length;
        await this.auditModel.save(
          this.auditModel.create({
            taskId: Number(task.id),
            action: 'publish',
            target: `${module}/${articleKey}`,
            beforeSnapshot: { status: 'draft' },
            afterSnapshot: { status: 'published', ids },
            rollbackRef: ids.join(','),
            status: 'success',
          })
        );
      }

      const result = {
        generated: ids.length,
        published,
        review: { verdict: review.verdict, confidence: review.confidence, issues: review.issues },
        decision: published ? 'auto_published' : 'kept_draft',
        breakerRemaining: breaker.remaining,
      };
      task.status = 'done';
      task.result = result;
      await this.taskModel.save(task);
      return { taskId: Number(task.id), ...result };
    } catch (e: any) {
      task.status = 'failed';
      task.result = { error: e?.message };
      await this.taskModel.save(task);
      throw e;
    }
  }

  /** 回滚某次审计动作（PRD-08）。publish→回退草稿；generate→删除生成项。 */
  async rollback(auditId: number) {
    const audit = await this.auditModel.findOneBy({ id: String(auditId) });
    if (!audit) throw new Error('审计记录不存在');
    if (audit.status === 'rolledback') return { ok: true, message: '已回滚过' };
    const ids = (audit.rollbackRef || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new Error('无可回滚目标');

    if (audit.action === 'publish') {
      await this.questionModel.update({ id: In(ids) }, { status: 'draft' });
    } else if (audit.action === 'generate') {
      await this.questionModel.delete({ id: In(ids) });
    }
    audit.status = 'rolledback';
    await this.auditModel.save(audit);
    return { ok: true, rolledBack: ids.length, action: audit.action };
  }
}
