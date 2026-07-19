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
}
