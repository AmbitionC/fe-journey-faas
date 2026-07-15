import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 周期复盘记录（增长复盘系统）。
 * 每周一篇，沉淀"看了什么数据 → 得出什么判断 → 下周做什么"，
 * 让人和后续接手的 Agent 都能追溯每次决策的依据。
 */
@Entity({ name: 'growth_review' })
@Index('idx_growth_review_period', ['period'])
export class GrowthReviewEntity extends BaseEntity {
  @Column({ comment: '复盘周期，如 2026-W29 / 2026-07', length: 16 })
  period: string;

  @Column({ comment: '标题', length: 128 })
  title: string;

  @Column({ comment: '复盘正文(markdown，含数据快照/判断/下周行动)', type: 'text' })
  content: string;

  @Column({ comment: '状态: draft / done', length: 16, default: 'done' })
  status: string;
}
