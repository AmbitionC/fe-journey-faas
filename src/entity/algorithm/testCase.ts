import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base';

@Entity({ name: 'algorithm_test_case' })
export class AlgorithmTestCaseEntity extends BaseEntity {
  @Index('idx_testcase_problem')
  @Column({ comment: '关联题目 ID' })
  problemId: number;

  @Column({
    comment: '输入',
    type: 'text',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  input: string;

  @Column({
    comment: '预期输出',
    type: 'text',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  expectedOutput: string;

  @Column({ comment: '是否示例用例（前端可见）', default: false })
  isSample: boolean;

  @Column({ comment: '排序序号', default: 0 })
  orderNum: number;
}
