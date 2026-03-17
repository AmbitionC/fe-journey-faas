import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base';

@Entity({ name: 'algorithm_problem' })
export class AlgorithmProblemEntity extends BaseEntity {
  @Column({ comment: '题目标题', length: 200 })
  title: string;

  @Index('idx_algo_slug', { unique: true })
  @Column({ comment: 'URL 标识', length: 100 })
  slug: string;

  @Column({
    comment: '难度',
    type: 'enum',
    enum: ['easy', 'medium', 'hard'],
    default: 'easy',
  })
  difficulty: string;

  @Column({
    comment: '题目描述 (Markdown)',
    type: 'text',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  description: string;

  @Column({
    comment: '各语言模板代码 (JSON)',
    type: 'text',
    nullable: true,
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  defaultCode: string;

  @Column({
    comment: '题解 (Markdown)',
    type: 'text',
    nullable: true,
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  solution: string;

  @Column({ comment: '排序序号', default: 0 })
  orderNum: number;

  @Column({
    comment: '状态',
    type: 'enum',
    enum: ['draft', 'published'],
    default: 'draft',
  })
  status: string;

  @Column({ comment: '通过数', default: 0 })
  acceptCount: number;

  @Column({ comment: '提交数', default: 0 })
  submitCount: number;
}
