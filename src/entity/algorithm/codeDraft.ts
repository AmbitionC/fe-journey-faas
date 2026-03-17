import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base';

@Entity({ name: 'algorithm_code_draft' })
@Index('idx_draft_unique', ['userId', 'problemId', 'language'], { unique: true })
export class AlgorithmCodeDraftEntity extends BaseEntity {
  @Column({ comment: '用户 ID', length: 20 })
  userId: string;

  @Column({ comment: '题目 ID' })
  problemId: number;

  @Column({ comment: '编程语言', length: 20 })
  language: string;

  @Column({
    comment: '代码内容',
    type: 'text',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  code: string;
}
