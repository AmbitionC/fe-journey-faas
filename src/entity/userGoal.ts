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

  // ---- PRD-01 测评回写：教练读 learner_state 时拿到最新画像 ----
  @Column({ comment: '现状岗位 frontend/backend/other_tech/non_tech', length: 24, nullable: true })
  role: string;

  @Column({ comment: '年限档 lt1/y1_3/y3_5/y5plus', length: 16, nullable: true })
  yearsOfExp: string;

  @Column({ comment: '每周时间档 lt5/h5_10/h10_20/h20plus', length: 16, nullable: true })
  weeklyHours: string;
}
