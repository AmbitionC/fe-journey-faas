import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** 同期挑战期次（PRD-06）：每期同一道大题、同截止日期、同班级群。 */
@Entity({ name: 'cohort' })
export class CohortEntity extends BaseEntity {
  @Index('uniq_cohort_slug', { unique: true })
  @Column({ comment: '期次标识 slug', length: 64 })
  slug: string;

  @Column({ comment: '期次标题', length: 128 })
  title: string;

  @Column({ comment: '主推大题 slug（mission）', length: 64, default: '' })
  missionSlug: string;

  @Column({ comment: '简介', length: 500, default: '' })
  description: string;

  @Column({ comment: '开始时间', type: 'datetime', nullable: true })
  startAt: Date;

  @Column({ comment: '截止时间', type: 'datetime', nullable: true })
  endAt: Date;

  @Column({ comment: '状态: upcoming / active / ended', length: 16, default: 'upcoming' })
  status: string;

  @Column({ comment: '班级群二维码 URL（微信群码7天过期，个人号为常驻兜底）', length: 512, nullable: true })
  groupQrUrl: string;
}
