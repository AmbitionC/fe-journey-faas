import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** 新手引导设定的学习目标（PRD-03 F1，供个性化与画像用）。 */
@Entity({ name: 'user_goal' })
@Index('uniq_user_goal', ['userId'], { unique: true })
export class UserGoalEntity extends BaseEntity {
  @Column({ comment: '用户标识', length: 64 })
  userId: string;

  @Column({ comment: '目标 job/advance/ai/other', length: 16 })
  target: string;

  @Column({ comment: '水平 beginner/mid/senior', length: 16, nullable: true })
  level: string;

  @Column({ comment: '兴趣方向', type: 'json', nullable: true })
  interests: string[] | null;

  @Column({ comment: '备注', length: 255, nullable: true })
  note: string;
}
