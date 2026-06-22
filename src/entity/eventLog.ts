import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** 统一埋点事件（PRD-04 F1-1）。 */
@Entity({ name: 'event_log' })
@Index('idx_event_name_time', ['event', 'createTime'])
@Index('idx_event_user', ['userId'])
export class EventLogEntity extends BaseEntity {
  @Column({ comment: '用户标识(手机号 或 guest:ip)', length: 64, nullable: true })
  userId: string;

  @Column({ comment: '事件名 {模块}_{对象}_{动作}', length: 64 })
  event: string;

  @Column({ comment: '事件属性', type: 'json', nullable: true })
  props: any;

  @Column({ comment: 'UA', length: 256, nullable: true })
  ua: string;

  @Column({ comment: 'IP', length: 64, nullable: true })
  ip: string;
}
