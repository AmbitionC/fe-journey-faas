import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 面经问题聚类（PRD-05 F13b，embedding 聚类）。
 * 回答"xxx 公司最喜欢问的问题有哪些"：题条向量化 → 余弦阈值 + 并查集聚类 →
 * 代表问法 / 频次 / 公司列表 / 关联文章。聚类命名支持人工修订，重跑幂等。
 */
@Entity({ name: 'question_cluster' })
@Index('idx_qcluster_freq', ['frequency'])
export class QuestionClusterEntity extends BaseEntity {
  @Column({ comment: '代表问法', length: 255 })
  representative: string;

  @Column({ comment: '出现频次', type: 'int', default: 1 })
  frequency: number;

  @Column({ comment: '涉及公司（json 字符串数组）', type: 'json', nullable: true })
  companies: any;

  @Column({ comment: '关联文章 key（json）', type: 'json', nullable: true })
  articleKeys: any;

  @Column({ comment: '同簇问法样例（json，去重后前若干条）', type: 'json', nullable: true })
  variants: any;

  @Column({ comment: '是否人工确认过命名', default: false })
  curated: boolean;
}
