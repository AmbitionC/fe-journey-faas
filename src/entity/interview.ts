import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'interview_experience' })
export class InterviewEntity extends BaseEntity {
  @Column({ comment: '原始标题' })
  title: string;

  @Column({ comment: '原始内容', type: 'text' })
  content: string;

  @Column({ comment: '原文链接' })
  url: string;

  @Column({ comment: '发布人', nullable: true })
  author?: string;

  @Column({ comment: '发布时间', nullable: true })
  publishTime?: string;

  @Column({ comment: 'AI生成的标题', nullable: true })
  aiTitle?: string;

  @Column({ comment: 'AI生成的内容', type: 'text', nullable: true })
  aiContent?: string;

  @Column({ comment: '处理状态', default: 'verified' })
  status: string;

  @Column({ comment: '来源平台', default: 'nowcoder' })
  source: string;
}
