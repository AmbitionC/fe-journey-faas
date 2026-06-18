import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * AI 消息（对应 ascp 的「message / messageId」），归属某个会话。
 * 仅持久化 user / assistant 轮次；注入的文章上下文 system 消息不落库。
 */
@Entity({ name: 'ai_message' })
@Index('idx_msg_conv', ['conversationId', 'id'])
@Index('idx_msg_user', ['userId'])
export class AiMessageEntity extends BaseEntity {
  @Column({ comment: '会话ID' })
  conversationId: number;

  @Column({ comment: '用户ID', length: 64 })
  userId: string;

  @Column({ comment: '角色: user | assistant | system', length: 16 })
  role: string;

  @Column({ comment: '内容', type: 'mediumtext' })
  content: string;

  @Column({ comment: '思维链(可选)', type: 'text', nullable: true })
  reasoning?: string;

  @Column({ comment: '状态: success | error', length: 16, default: 'success' })
  status: string;

  @Column({ comment: '消耗 token', default: 0 })
  tokenUsed: number;
}
