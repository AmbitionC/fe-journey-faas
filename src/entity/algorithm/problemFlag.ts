import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base';

@Entity({ name: 'algorithm_problem_flag' })
@Index('idx_flag_unique', ['userId', 'slug'], { unique: true })
export class AlgorithmProblemFlagEntity extends BaseEntity {
  @Column({ comment: '用户 ID', length: 50 })
  userId: string;

  @Column({ comment: '题目 slug', length: 100 })
  slug: string;

  @Column({
    comment: '标记类型',
    type: 'enum',
    enum: ['favorite', 'redo'],
  })
  flag: 'favorite' | 'redo';
}
