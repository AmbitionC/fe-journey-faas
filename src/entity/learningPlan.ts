import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 学习计划（PRD-01 §5）。一人同时最多一份 active。
 * 测评在试用到期触发（无游客链路）；测评快照冗余存入计划。
 */
@Entity({ name: 'learning_plan' })
@Index('idx_lplan_user', ['userId'])
export class LearningPlanEntity extends BaseEntity {
  @Column({ comment: '用户标识（手机号）', length: 64 })
  userId: string;

  @Column({ comment: '学习目标: agent_dev / ai_skill / ai_job', length: 24, default: 'agent_dev' })
  goal: string;

  @Column({ comment: '现状: frontend/backend/other_tech/non_tech', length: 24, default: '' })
  currentRole: string;

  @Column({ comment: '年限档: lt1/y1_3/y3_5/y5plus', length: 16, default: '' })
  yearsOfExp: string;

  @Column({ comment: '每周时间档: lt5/h5_10/h10_20/h20plus', length: 16, default: 'h5_10' })
  weeklyHours: string;

  @Column({ comment: '测评完整快照（json）', type: 'json', nullable: true })
  assessmentSnapshot: any;

  @Column({ comment: '起点段 1-3', type: 'int', default: 1 })
  startSegment: number;

  @Column({ comment: '总周数', type: 'int', default: 12 })
  totalWeeks: number;

  @Column({ comment: '当前进行到第几周', type: 'int', default: 1 })
  currentWeekNo: number;

  @Column({ comment: '来源: static(骨架) / ai(个性化)', length: 16, default: 'static' })
  source: string;

  @Column({ comment: '状态: active/paused/finished/abandoned', length: 16, default: 'active' })
  status: string;

  @Column({ comment: '骨架模板版本号', length: 16, default: 'v1' })
  skeletonVersion: string;
}
