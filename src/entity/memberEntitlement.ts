import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 会员权益记录（PRD-07 §4.1 F1 权益网关 / 4.0 会员模型）。
 *
 * 一条记录 = 一段有效期的会员资格来源。会员判定 = 存在 expireAt > now 的记录（查询时判定，
 * 无需定时任务）。支持多来源叠加：注册送 7 天试用（source=trial，每手机号一次）、
 * 购买续费（source=purchase，有效期从当前有效期顺延）、管理员赠送、限免退出过渡期。
 */
@Entity({ name: 'member_entitlement' })
@Index('idx_ment_user', ['userId'])
@Index('idx_ment_expire', ['expireAt'])
export class MemberEntitlementEntity extends BaseEntity {
  @Column({ comment: '用户标识（手机号）', length: 64 })
  userId: string;

  @Column({ comment: '来源: trial / purchase / admin_grant / legacy_free', length: 24 })
  source: string;

  @Column({ comment: '生效时间', type: 'datetime' })
  startAt: Date;

  @Column({ comment: '到期时间（查询时判定，无需定时任务）', type: 'datetime' })
  expireAt: Date;

  @Column({ comment: '附加信息（订单号/管理员备注等）', type: 'json', nullable: true })
  meta: any;
}
