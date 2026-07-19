import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 能力曲线数据点（PRD-03）。跨题目、跨场次的分维能力积累。
 * 每通过一次评审写入若干维度的一条数据点；能力曲线 = 按维度按时间聚合。
 * 5 维：requirement(需求理解) / ai_direction(AI指挥) / engineering(工程实现)
 *      / debugging(调试纠偏) / knowledge(知识运用)。
 */
@Entity({ name: 'skill_score' })
@Index('idx_skill_user', ['userId'])
@Index('idx_skill_user_dim', ['userId', 'dimension'])
export class SkillScoreEntity extends BaseEntity {
  @Column({ comment: '用户标识', length: 64 })
  userId: string;

  @Column({ comment: '维度: requirement/ai_direction/engineering/debugging/knowledge', length: 24 })
  dimension: string;

  @Column({ comment: '本次得分 0-100', type: 'int', default: 0 })
  score: number;

  @Column({ comment: '来源做题记录 id', type: 'int', nullable: true })
  submissionId: number;

  @Column({ comment: '权重（分档求助已废除，恒为 1；保留字段便于扩展）', type: 'float', default: 1 })
  weight: number;
}
