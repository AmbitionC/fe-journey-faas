import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 文章向量（PRD-09 决策 8，阶段 2）。text-embedding-v4 自存向量，FC 内存做余弦，
 * 不引入向量数据库。vector 以 base64(Float32) 存储（比 JSON 数组省一半空间）。
 */
@Entity({ name: 'content_embedding' })
@Index('uniq_cemb', ['module', 'articleKey'], { unique: true })
export class ContentEmbeddingEntity extends BaseEntity {
  @Column({ comment: '所属模块', length: 20 })
  module: string;

  @Column({ comment: '文章 key', length: 100 })
  articleKey: string;

  @Column({ comment: '标题（召回展示用）', length: 255, default: '' })
  title: string;

  @Column({ comment: '向量 base64(Float32)', type: 'mediumtext' })
  vector: string;

  @Column({ comment: '维度', type: 'int', default: 0 })
  dim: number;

  @Column({ comment: 'embedding 模型名', length: 32, default: '' })
  model: string;
}
