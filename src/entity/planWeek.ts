import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 计划周（PRD-01 §5）。learning_plan 的子表，一周一行。
 * nodes: [{type:'read_teach'|'mission', ref, title, status:'todo'|'done', doneAt}]
 */
@Entity({ name: 'plan_week' })
@Index('idx_pweek_plan', ['planId'])
export class PlanWeekEntity extends BaseEntity {
  @Column({ comment: '关联 learning_plan.id', type: 'int' })
  planId: number;

  @Column({ comment: '第几周（1 起）', type: 'int' })
  weekNo: number;

  @Column({ comment: '归属骨架段 1-6', type: 'int', default: 1 })
  segment: number;

  @Column({ comment: '本周主题', length: 255, default: '' })
  theme: string;

  @Column({ comment: '节点数组（json）', type: 'json', nullable: true })
  nodes: any;

  @Column({ comment: '状态: pending/active/done/skipped', length: 16, default: 'pending' })
  status: string;

  @Column({ comment: '对账提交时间，null=未对账', type: 'datetime', nullable: true })
  checkinAt: Date;

  @Column({ comment: '对账数据（json：{completed,total,blocker,blockerText,adjustChoice}）', type: 'json', nullable: true })
  checkinData: any;

  @Column({ comment: '本周被调整的原因说明（展示给用户）', length: 255, nullable: true })
  aiAdjustNote: string;
}
