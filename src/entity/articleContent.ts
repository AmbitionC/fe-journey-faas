import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 文章正文索引（教练地基 P0，检索设计 §2 / PRD-04 P0 / PRD-09 数据模型）。
 *
 * 现有词法检索只覆盖「标题/路径/标签」，正文级问题（如"防抖和节流的区别"）召回不到。
 * 本表把文章 markdown 正文入库，配合 MySQL ngram FULLTEXT 索引，作为 search_articles
 * 工具的第二路召回（正文）。全站规模约 1-2MB，量级毫无压力。
 *
 * 写入：内容同步链路（/content/sync）在 oss.put 后顺带 upsert；全量回填走 /content/reindex。
 * ngram FULLTEXT 索引由 ArticleContentService.ensureFulltextIndex() 幂等自愈创建
 *（TypeORM 装饰器不支持 WITH PARSER ngram，且不依赖 synchronize 的 FULLTEXT 行为）。
 */
@Entity({ name: 'article_content' })
@Index('uniq_article_content', ['module', 'articleKey'], { unique: true })
export class ArticleContentEntity extends BaseEntity {
  @Column({ comment: '所属模块: interview | knowledge | firstclass', length: 20 })
  module: string;

  @Column({ comment: '文章唯一标识，对应 nav 中的 key', length: 100 })
  articleKey: string;

  @Column({ comment: '文章在仓库中的子路径（扁平模块为空），read_article 据此定位 OSS 对象', length: 255, default: '' })
  filePath: string;

  @Column({ comment: '文章标题（检索结果展示用）', length: 255, default: '' })
  title: string;

  @Column({ comment: '正文 markdown（ngram FULLTEXT 索引由 service 幂等创建）', type: 'mediumtext' })
  content: string;

  @Column({ comment: '最近同步时间', type: 'datetime', nullable: true })
  syncedAt: Date;
}
