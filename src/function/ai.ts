import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
  Config,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { AiProxyService, ChatMessage, ChatContext } from '../service/ai/proxy';
import { UserEntity } from '../entity/user';

class AIChatDTO {
  messages: ChatMessage[];
  context: ChatContext;
}

@Provide()
export class AiHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  aiProxyService: AiProxyService;

  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @Config('ai')
  aiConfig: { rateLimit: { freeUserPerDay: number } };

  private async getIsMember(userId: string): Promise<boolean> {
    try {
      const user = await this.userModel.findOneBy({ phoneNumber: userId });
      if (!user?.isMember || !user?.memberDate) return false;
      return new Date(user.memberDate) > new Date();
    } catch {
      return false;
    }
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 问答配额查询',
    functionName: 'aiQuota',
    name: 'aiQuota',
    path: '/api/ai/quota',
    method: 'get',
  })
  async aiQuota() {
    const userId = this.ctx.userInfo?.userId;
    const isMember = await this.getIsMember(userId);
    const quota = await this.aiProxyService.getQuota(userId, isMember);
    return { success: true, data: { ...quota, isMember } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 聊天（普通响应）',
    functionName: 'aiChat',
    name: 'aiChat',
    path: '/api/ai/chat',
    method: 'post',
  })
  async aiChat(@Body(ALL) body: AIChatDTO) {
    const userId = this.ctx.userInfo?.userId;
    const isMember = await this.getIsMember(userId);
    await this.aiProxyService.checkRateLimit(userId, isMember);

    const content = await this.aiProxyService.forward(
      body.messages,
      body.context,
      userId
    );

    return { success: true, content };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 聊天（SSE 流式响应）',
    functionName: 'aiChatStream',
    name: 'aiChatStream',
    path: '/api/ai/chat/stream',
    method: 'post',
  })
  async aiChatStream(@Body(ALL) body: AIChatDTO) {
    const userId = this.ctx.userInfo?.userId;
    const isMember = await this.getIsMember(userId);
    await this.aiProxyService.checkRateLimit(userId, isMember);

    this.ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
    this.ctx.set('Cache-Control', 'no-cache');
    this.ctx.set('Connection', 'keep-alive');
    this.ctx.set('X-Accel-Buffering', 'no');
    this.ctx.respond = false;

    const res = this.ctx.res;

    try {
      const gen = this.aiProxyService.forwardStream(
        body.messages,
        body.context,
        userId
      );

      for await (const chunk of gen) {
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ error: err?.message || 'AI 请求失败' })}\n\n`);
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}
