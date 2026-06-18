import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * AI 会话（对应 ascp 的「chat / chatId」）。
 * 一个用户（登录=手机号 / 游客=guest:ip）可有多个会话，按 lastMessageAt 倒序展示。
 */
@Entity({ name: 'ai_conversation' })
@Index('idx_conv_user_status', ['userId', 'status'])
@Index('idx_conv_user_time', ['userId', 'lastMessageAt'])
export class AiConversationEntity extends BaseEntity {
  @Column({ comment: '用户ID(手机号 或 guest:ip)', length: 64 })
  userId: string;

  @Column({ comment: '会话标题', length: 200, default: '新对话' })
  title: string;

  @Column({ comment: '所属模块', length: 32, nullable: true })
  module?: string;

  @Column({ comment: '关联文章 key', length: 128, nullable: true })
  articleKey?: string;

  @Column({ comment: '状态: active | deleted', length: 16, default: 'active' })
  status: string;

  @Column({ comment: '消息数', default: 0 })
  messageCount: number;

  @Column({ comment: '最后消息时间', type: 'datetime', nullable: true })
  lastMessageAt?: Date;
}
