import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** 学习路径 / 技能树（PRD-03 F2）。一条路径串若干文章，按序学习。 */
@Entity({ name: 'learning_path' })
export class LearningPathEntity extends BaseEntity {
  @Index('idx_path_slug', { unique: true })
  @Column({ comment: '路径标识', length: 100 })
  slug: string;

  @Column({ comment: '标题', length: 200 })
  title: string;

  @Column({ comment: '描述', type: 'text', nullable: true })
  description: string;

  @Column({ comment: '路径项 [{module,articleKey,label}]', type: 'json', nullable: true })
  items: { module: string; articleKey: string; label: string }[] | null;

  @Column({ comment: '状态 draft/published', length: 16, default: 'draft' })
  status: string;

  @Column({ comment: '排序', type: 'int', default: 0 })
  orderNum: number;
}
