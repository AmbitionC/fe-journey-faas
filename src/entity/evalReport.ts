import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base';

/** AI 评测报告存档（PRD-02 F2-3 → PRD-04 可观测）。 */
@Entity({ name: 'eval_report' })
export class EvalReportEntity extends BaseEntity {
  @Column({ comment: '指标与明细', type: 'json' })
  metrics: any;

  @Column({ comment: '判分正确率 0-1', type: 'float', default: 0 })
  gradeAccuracy: number;
}
