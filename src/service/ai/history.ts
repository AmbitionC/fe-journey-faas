import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { AiConversationEntity } from '../../entity/aiConversation';
import { AiMessageEntity } from '../../entity/aiMessage';

const DEFAULT_TITLE = '新对话';
const MAX_TITLE = 30;

/** AI 会话与消息的持久化服务（对应 ascp 的 chatList / chat/messages / updateChat / chat/delete）。 */
@Provide()
export class AiHistoryService {
  @InjectEntityModel(AiConversationEntity)
  convModel: Repository<AiConversationEntity>;

  @InjectEntityModel(AiMessageEntity)
  msgModel: Repository<AiMessageEntity>;

  private titleFrom(text?: string): string {
    const t = (text || '').trim().replace(/\s+/g, ' ');
    if (!t) return DEFAULT_TITLE;
    return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE)}…` : t;
  }

  /** 取或建会话：传了属于该用户的 conversationId 则复用，否则新建。 */
  async ensureConversation(
    userId: string,
    conversationId: number | undefined,
    ctx: { module?: string; articleKey?: string; firstUserText?: string }
  ): Promise<AiConversationEntity> {
    if (conversationId) {
      const exist = await this.convModel.findOneBy({
        id: conversationId as any,
        userId,
        status: 'active',
      });
      if (exist) return exist;
    }
    const conv = this.convModel.create({
      userId,
      title: this.titleFrom(ctx.firstUserText),
      module: ctx.module,
      articleKey: ctx.articleKey,
      status: 'active',
      messageCount: 0,
      lastMessageAt: new Date(),
    });
    return this.convModel.save(conv);
  }

  /** 追加一条消息并更新会话统计。 */
  async appendMessage(
    conv: AiConversationEntity,
    msg: {
      role: string;
      content: string;
      reasoning?: string;
      status?: string;
      tokenUsed?: number;
    }
  ): Promise<AiMessageEntity> {
    const entity = this.msgModel.create({
      conversationId: conv.id as any,
      userId: conv.userId,
      role: msg.role,
      content: msg.content,
      reasoning: msg.reasoning,
      status: msg.status || 'success',
      tokenUsed: msg.tokenUsed || 0,
    });
    const saved = await this.msgModel.save(entity);
    await this.convModel.increment({ id: conv.id as any }, 'messageCount', 1);
    await this.convModel.update(
      { id: conv.id as any },
      { lastMessageAt: new Date() }
    );
    return saved;
  }

  /** 会话列表（按最后消息时间倒序，分页）。 */
  async listConversations(userId: string, page = 1, pageSize = 20) {
    const take = Math.min(Math.max(pageSize, 1), 50);
    const skip = (Math.max(page, 1) - 1) * take;
    const [rows, total] = await this.convModel.findAndCount({
      where: { userId, status: 'active' },
      order: { lastMessageAt: 'DESC', id: 'DESC' },
      skip,
      take,
    });
    return {
      list: rows.map((r) => ({
        id: r.id,
        title: r.title,
        module: r.module,
        articleKey: r.articleKey,
        messageCount: r.messageCount,
        lastMessageAt: r.lastMessageAt,
      })),
      total,
      hasMore: skip + rows.length < total,
    };
  }

  /** 会话历史消息（校验归属，正序）。 */
  async listMessages(userId: string, conversationId: number) {
    const conv = await this.convModel.findOneBy({
      id: conversationId as any,
      userId,
      status: 'active',
    });
    if (!conv) return { conversation: null, list: [] };
    const rows = await this.msgModel.find({
      where: { conversationId: conversationId as any },
      order: { id: 'ASC' },
      take: 200,
    });
    return {
      conversation: {
        id: conv.id,
        title: conv.title,
        module: conv.module,
        articleKey: conv.articleKey,
      },
      list: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        status: r.status,
        createTime: r.createTime,
      })),
    };
  }

  /** 改名（校验归属）。 */
  async rename(userId: string, conversationId: number, title: string) {
    const t = (title || '').trim().slice(0, 200);
    if (!t) return { updated: false };
    const res = await this.convModel.update(
      { id: conversationId as any, userId },
      { title: t }
    );
    return { updated: (res.affected || 0) > 0, title: t };
  }

  /** 软删除（校验归属）。 */
  async softDelete(userId: string, conversationId: number) {
    const res = await this.convModel.update(
      { id: conversationId as any, userId },
      { status: 'deleted' }
    );
    return { deleted: (res.affected || 0) > 0 };
  }
}
