import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 手动录入的经营指标时间序列（增长复盘系统）。
 * 站外/线下数据（小红书粉丝、私域人数、月成本等）无法自动采集，
 * 每周复盘时在 manager「增长复盘」页录入一次。
 * 约定 metric 取值见 docs/growth-review-playbook.md（front-end-journey 仓库）。
 */
@Entity({ name: 'growth_stat' })
@Index('idx_growth_stat_metric_date', ['metric', 'statDate'], { unique: true })
export class GrowthStatEntity extends BaseEntity {
  @Column({ comment: '统计日期 YYYY-MM-DD', length: 10 })
  statDate: string;

  @Column({
    comment: '指标名: xhs_followers / xhs_notes / group_members / monthly_cost / 自定义',
    length: 64,
  })
  metric: string;

  @Column({ comment: '指标值', type: 'decimal', precision: 12, scale: 2 })
  value: number;

  @Column({ comment: '备注(如成本构成、异常说明)', length: 256, nullable: true })
  note: string;
}
