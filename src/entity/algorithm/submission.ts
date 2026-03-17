import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base';

@Entity({ name: 'algorithm_submission' })
export class AlgorithmSubmissionEntity extends BaseEntity {
  @Index('idx_submission_problem')
  @Column({ comment: '题目 ID' })
  problemId: number;

  @Index('idx_submission_user')
  @Column({ comment: '用户 ID', length: 20 })
  userId: string;

  @Column({ comment: '类型: run=运行 submit=提交', length: 10, default: 'submit' })
  type: string;

  @Column({ comment: '编程语言', length: 20 })
  language: string;

  @Column({
    comment: '提交代码',
    type: 'text',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  code: string;

  @Column({
    comment: '判定状态',
    type: 'enum',
    enum: [
      'pending',
      'accepted',
      'wrong_answer',
      'time_limit_exceeded',
      'runtime_error',
      'compile_error',
    ],
    default: 'pending',
  })
  status: string;

  @Column({ comment: '运行时间(ms)', nullable: true })
  runtime: number;

  @Column({ comment: '内存(KB)', nullable: true })
  memory: number;

  @Column({
    comment: '错误信息',
    type: 'text',
    nullable: true,
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  errorMessage: string;

  @Column({
    comment: '各用例结果 (JSON)',
    type: 'text',
    nullable: true,
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  testResults: string;
}
