import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 测一测作答记录（PRD-01 F1-1）。一次提交一条，记录得分与汇总反馈。
 */
@Entity({ name: 'quiz_attempt' })
@Index('idx_attempt_user_article', ['userId', 'module', 'articleKey'])
export class QuizAttemptEntity extends BaseEntity {
  @Column({ comment: '用户标识(手机号 或 guest:ip)', length: 64 })
  userId: string;

  @Column({ comment: '所属模块', length: 20 })
  module: string;

  @Column({ comment: '所属文章 key', length: 100 })
  articleKey: string;

  @Column({ comment: '每题作答 [{questionId,answer,correct,verdict?}]', type: 'json', nullable: true })
  answers: any;

  @Column({ comment: '得分 0-100', type: 'int', default: 0 })
  score: number;

  @Column({ comment: '答对题数', type: 'int', default: 0 })
  correctCount: number;

  @Column({ comment: '总题数', type: 'int', default: 0 })
  totalCount: number;

  @Column({
    comment: '定制化建议 { diagnosis, suggestions? }',
    type: 'json',
    nullable: true,
  })
  feedback: any;

  @Column({ comment: '耗时 ms', type: 'bigint', default: 0 })
  durationMs: number;
}
