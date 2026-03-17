import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base';

@Entity({ name: 'algorithm_problem_tag' })
@Index('idx_problem_tag', ['problemId', 'tagId'], { unique: true })
export class AlgorithmProblemTagEntity extends BaseEntity {
  @Column({ comment: '题目 ID' })
  problemId: number;

  @Column({ comment: '标签 ID' })
  tagId: number;
}
