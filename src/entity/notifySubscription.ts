import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** 触达订阅（PRD-06 F1）：邮箱/服务号授权采集，复习提醒/周报投递。 */
@Entity({ name: 'notify_subscription' })
@Index('uniq_notify_user_channel', ['userId', 'channel'], { unique: true })
export class NotifySubscriptionEntity extends BaseEntity {
  @Column({ comment: '用户标识', length: 64 })
  userId: string;

  @Column({ comment: '渠道 email/wechat', length: 16 })
  channel: string;

  @Column({ comment: '投递地址(邮箱/openid)', length: 128 })
  address: string;

  @Column({ comment: '是否启用', type: 'boolean', default: true })
  enabled: boolean;

  @Column({ comment: '订阅类型 [review,weekly]', type: 'json', nullable: true })
  types: string[] | null;
}
