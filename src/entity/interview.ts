import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'interview_experience' })
export class InterviewEntity extends BaseEntity {
  @Column({
    comment: '原始标题',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  title: string;

  @Column({
    comment: '原始内容',
    type: 'text',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  content: string;

  @Column({
    comment: '原文链接',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  url: string;

  @Column({
    comment: '发布人',
    nullable: true,
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  author?: string;

  @Column({ comment: '发布时间', nullable: true })
  publishTime?: string;

  @Column({
    comment: 'AI生成的标题',
    nullable: true,
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  aiTitle?: string;

  @Column({
    comment: 'AI生成的内容',
    type: 'text',
    nullable: true,
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  aiContent?: string;

  @Column({ comment: '处理状态', default: 'verified' })
  status: string;

  @Column({ comment: '来源平台', default: 'nowcoder' })
  source: string;
}
