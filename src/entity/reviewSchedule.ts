import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 间隔重复排程（PRD-01 F2-1）。每个 (user, module, article) 一条，SM-2 维护。
 */
@Entity({ name: 'review_schedule' })
@Index('uniq_srs_user_article', ['userId', 'module', 'articleKey'], { unique: true })
export class ReviewScheduleEntity extends BaseEntity {
  @Column({ comment: '用户标识', length: 64 })
  userId: string;

  @Column({ comment: '所属模块', length: 20 })
  module: string;

  @Column({ comment: '文章 key', length: 100 })
  articleKey: string;

  @Column({ comment: '难度系数', type: 'float', default: 2.5 })
  ease: number;

  @Column({ comment: '间隔天数', type: 'int', default: 0 })
  interval: number;

  @Column({ comment: '连续答对次数', type: 'int', default: 0 })
  reps: number;

  @Column({ comment: '下次到期(ms)', type: 'bigint', default: 0 })
  dueAt: number;

  @Column({ comment: '最近一次结果 again/hard/good/easy', length: 10, nullable: true })
  lastResult: string;
}
