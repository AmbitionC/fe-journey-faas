import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 期次发布内容（PRD-06 F5）。只存「已发布」——起草在站长外部 skill 里完成，
 * 系统只做发布接口 + 展示，不做站内起草/审发队列（运营外置原则）。
 */
@Entity({ name: 'cohort_post' })
@Index('idx_cpost_cohort', ['cohortId'])
@Index('uniq_cpost_key', ['cohortId', 'idemKey'], { unique: true })
export class CohortPostEntity extends BaseEntity {
  @Column({ comment: '期次 id', type: 'int' })
  cohortId: number;

  @Column({ comment: '幂等键（同 key 重复发布不重复建）', length: 64 })
  idemKey: string;

  @Column({ comment: '标题', length: 128, default: '' })
  title: string;

  @Column({ comment: '正文 markdown', type: 'text' })
  content: string;
}
