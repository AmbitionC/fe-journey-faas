import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 测一测题目（PRD-01 F1-1）。归属某篇文章（module + articleKey），
 * 题型 single/multi/blank/qa；前三类规则判分，qa 交 AI 判分。
 */
@Entity({ name: 'quiz_question' })
@Index('idx_quiz_article', ['module', 'articleKey'])
export class QuizQuestionEntity extends BaseEntity {
  @Column({ comment: '所属模块 interview/knowledge/firstclass', length: 20 })
  module: string;

  @Column({ comment: '所属文章 key', length: 100 })
  articleKey: string;

  @Column({ comment: '题型 single/multi/blank/qa', length: 10, default: 'single' })
  type: string;

  @Column({ comment: '题干', type: 'text', charset: 'utf8mb4' })
  stem: string;

  @Column({ comment: '选项(选择题用) [{key,text}]', type: 'json', nullable: true })
  options: { key: string; text: string }[] | null;

  @Column({
    comment: '标准答案/要点：选择题为 key 数组，填空/简答为要点字符串数组',
    type: 'json',
    nullable: true,
  })
  answer: string[] | null;

  @Column({ comment: '解析', type: 'text', nullable: true, charset: 'utf8mb4' })
  analysis: string | null;

  @Column({ comment: '难度 1/2/3', type: 'int', default: 1 })
  difficulty: number;

  @Column({ comment: '来源 manual/ai', length: 10, default: 'manual' })
  source: string;

  @Column({ comment: '状态 draft/published/archived', length: 16, default: 'draft' })
  status: string;

  @Column({ comment: '标签', type: 'json', nullable: true })
  tags: string[] | null;

  @Column({ comment: '排序', type: 'int', default: 0 })
  orderNum: number;
}
