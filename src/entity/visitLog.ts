import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'visit_log' })
@Index('idx_user_date', ['userId', 'visitDate'], { unique: true })
export class VisitLogEntity extends BaseEntity {
  @Column({ comment: '用户标识（手机号）' })
  userId: string;

  @Column({ comment: '访问日期 YYYY-MM-DD' })
  visitDate: string;

  @Column({ comment: '当日访问次数', default: 0 })
  count: number;
}
