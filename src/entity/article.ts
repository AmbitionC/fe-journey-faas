import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'article' })
export class ArticleEntity extends BaseEntity {
  @Index('idx_article_key', { unique: true })
  @Column({ comment: '文章唯一标识，对应 nav 中的 key', length: 100 })
  articleKey: string;

  @Column({ comment: '所属模块: interview | knowledge | firstclass', length: 20 })
  module: string;

  @Column({ comment: '文章标题', length: 255, default: '' })
  title: string;

  @Column({ comment: '点赞数', default: 0 })
  likeCount: number;

  @Column({ comment: '收藏数', default: 0 })
  bookmarkCount: number;

  @Column({ comment: '分享数', default: 0 })
  shareCount: number;

  @Column({ comment: '浏览数', default: 0 })
  viewCount: number;
}
