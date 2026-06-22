import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** AI 运营任务（PRD-08）。 */
@Entity({ name: 'ops_task' })
@Index('idx_ops_task_type', ['type', 'status'])
export class OpsTaskEntity extends BaseEntity {
  @Column({ comment: '类型 health/tag/clean/generate...', length: 32 })
  type: string;

  @Column({ comment: '范围(模块/文章等)', type: 'json', nullable: true })
  scope: any;

  @Column({ comment: '状态 running/done/paused/failed', length: 16, default: 'done' })
  status: string;

  @Column({ comment: '结果摘要', type: 'json', nullable: true })
  result: any;
}

/** 内容健康报告（PRD-08 F1-2）。 */
@Entity({ name: 'content_health_report' })
@Index('idx_health_article', ['module', 'articleKey'])
export class ContentHealthReportEntity extends BaseEntity {
  @Column({ comment: '模块', length: 20 })
  module: string;

  @Column({ comment: '文章 key', length: 100 })
  articleKey: string;

  @Column({ comment: '健康分 0-100', type: 'int', default: 100 })
  score: number;

  @Column({ comment: '问题清单', type: 'json', nullable: true })
  issues: any;
}

/** 操作审计 + 回滚指针（PRD-08）。 */
@Entity({ name: 'ops_audit_log' })
@Index('idx_ops_audit_task', ['taskId'])
export class OpsAuditLogEntity extends BaseEntity {
  @Column({ comment: '任务ID', nullable: true })
  taskId: number;

  @Column({ comment: '动作', length: 32 })
  action: string;

  @Column({ comment: '目标', length: 200, nullable: true })
  target: string;

  @Column({ comment: '前快照', type: 'json', nullable: true })
  beforeSnapshot: any;

  @Column({ comment: '后快照', type: 'json', nullable: true })
  afterSnapshot: any;

  @Column({ comment: '回滚指针(commit/快照id)', length: 128, nullable: true })
  rollbackRef: string;

  @Column({ comment: '状态 success/failed/rolledback', length: 16, default: 'success' })
  status: string;
}

/** AI 审 AI 复核记录（PRD-08）。执行 agent 产出 → 审查 agent 复核。 */
@Entity({ name: 'ops_review' })
@Index('idx_ops_review_task', ['taskId'])
export class OpsReviewEntity extends BaseEntity {
  @Column({ comment: '任务ID', nullable: true })
  taskId: number;

  @Column({ comment: '审查模型', length: 32, nullable: true })
  reviewerModel: string;

  @Column({ comment: '结论 pass/fail', length: 16 })
  verdict: string;

  @Column({ comment: '置信度 0-1', type: 'float', default: 0 })
  confidence: number;

  @Column({ comment: '问题列表', type: 'json', nullable: true })
  issues: any;
}

/** 人工抽检记录（PRD-08）。反哺评测。 */
@Entity({ name: 'sampling_check' })
@Index('idx_sampling_task', ['taskId'])
export class SamplingCheckEntity extends BaseEntity {
  @Column({ comment: '关联任务/审计ID', nullable: true })
  taskId: number;

  @Column({ comment: '抽检人', length: 64, nullable: true })
  sampler: string;

  @Column({ comment: '结果 ok/wrong/doubt', length: 16 })
  result: string;

  @Column({ comment: '备注', length: 500, nullable: true })
  note: string;
}
