import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** 期次成员（PRD-06）。 */
@Entity({ name: 'cohort_member' })
@Index('idx_cmember_cohort', ['cohortId'])
@Index('uniq_cmember', ['cohortId', 'userId'], { unique: true })
export class CohortMemberEntity extends BaseEntity {
  @Column({ comment: '期次 id', type: 'int' })
  cohortId: number;

  @Column({ comment: '用户标识', length: 64 })
  userId: string;

  @Column({ comment: '昵称（进度榜展示）', length: 64, default: '' })
  nickName: string;

  @Column({ comment: '是否匿名显示', default: false })
  anonymous: boolean;

  @Column({ comment: '里程碑进度（json：{claimed,plan,building,submitted,passed}）', type: 'json', nullable: true })
  progress: any;

  @Column({ comment: '里程碑打卡（json：{milestoneKey: 时间戳}，成员自报"我到这步了"）', type: 'json', nullable: true })
  milestoneChecks: any;

  @Column({ comment: '结营展示物（json：{title,content,repoUrl,deployUrl}）', type: 'json', nullable: true })
  showcase: any;

  @Column({ comment: '是否同意展示到作品墙', default: false })
  wallOptIn: boolean;

  @Column({ comment: '是否结营（通过当期大题即得结营徽章）', default: false })
  completion: boolean;
}
