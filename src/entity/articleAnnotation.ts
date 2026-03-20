import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'article_annotation' })
@Index('idx_annotation_article', ['articleKey', 'module'])
@Index('idx_annotation_user', ['userId'])
export class ArticleAnnotationEntity extends BaseEntity {
  @Column({ comment: '用户ID', length: 20 })
  userId: string;

  @Column({ comment: '用户昵称', length: 50, default: '' })
  nickName: string;

  @Column({ comment: '文章唯一标识', length: 100 })
  articleKey: string;

  @Column({ comment: '所属模块: interview | knowledge | firstclass', length: 20 })
  module: string;

  @Column({ comment: '类型: highlight | note', length: 10 })
  type: string;

  @Column({ type: 'text', comment: '选中的文本' })
  selectedText: string;

  @Column({ length: 200, comment: '选中文本前的上下文', default: '' })
  prefixText: string;

  @Column({ length: 200, comment: '选中文本后的上下文', default: '' })
  suffixText: string;

  @Column({ type: 'text', nullable: true, comment: '笔记内容（仅 note 类型）' })
  noteContent: string;
}
