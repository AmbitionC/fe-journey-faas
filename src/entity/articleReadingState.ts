import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'article_reading_state' })
@Index('uniq_user_module_article', ['userId', 'module', 'articleKey'], { unique: true })
export class ArticleReadingStateEntity extends BaseEntity {
  @Column({ comment: '用户标识(手机号)', length: 64 })
  userId: string;

  @Column({ comment: '所属模块', length: 20 })
  module: string;

  @Column({ comment: '文章标识', length: 100 })
  articleKey: string;

  @Column({ comment: '状态 unread/reading/done', length: 16, default: 'unread' })
  status: string;

  @Column({ comment: '掌握度 new/review/mastered', length: 16, nullable: true })
  mastery: string;

  @Column({ comment: '最近学习时间(epoch ms)', type: 'bigint', default: 0 })
  lastReadAt: number;
}
