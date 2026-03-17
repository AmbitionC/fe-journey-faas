import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'article_view_log' })
@Index('idx_article_view', ['articleKey', 'viewDate'])
@Index('idx_fingerprint_article', ['fingerprint', 'articleKey'])
export class ArticleViewLogEntity extends BaseEntity {
  @Column({ comment: '文章标识', length: 100 })
  articleKey: string;

  @Column({ comment: '所属模块', length: 20 })
  module: string;

  @Column({ comment: '浏览者指纹(userId 或 IP hash)', length: 64 })
  fingerprint: string;

  @Column({ comment: '浏览日期 YYYY-MM-DD', length: 10 })
  viewDate: string;

  @Column({ comment: '来源 IP', length: 45, default: '' })
  ip: string;

  @Column({ comment: 'User-Agent', length: 500, default: '' })
  userAgent: string;
}
