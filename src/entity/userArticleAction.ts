import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'user_article_action' })
@Index('idx_user_article_action', ['userId', 'articleKey', 'actionType'], {
  unique: true,
})
export class UserArticleActionEntity extends BaseEntity {
  @Column({ comment: '用户 ID，关联 user 表', length: 20 })
  userId: string;

  @Column({ comment: '文章唯一标识', length: 100 })
  articleKey: string;

  @Column({ comment: '所属模块', length: 20 })
  module: string;

  @Column({ comment: '操作类型: like | bookmark', length: 10 })
  actionType: string;
}
