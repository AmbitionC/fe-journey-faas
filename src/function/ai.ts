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
import { RedisService } from '@midwayjs/redis';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { AiProxyService, ChatMessage, ChatContext } from '../service/ai/proxy';
import { UserEntity } from '../entity/user';
import { NoAuth } from '../decorator/noAuth';

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

  @Inject()
  redisService: RedisService;

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

  /**
   * 解析用户身份。AI 接口走 NoAuth（允许游客），但仍尝试解析 token：
   * 登录用户 → 真实 userId + 会员判断；游客 → 以 IP 作为限流标识。
   */
  private async resolveUser(): Promise<{ userId: string; isMember: boolean }> {
    const token =
      (this.ctx.header.token as string) ||
      (this.ctx.header.authorization as string)?.replace('Bearer ', '');
    if (token) {
      try {
        const infoStr = await this.redisService.get(`token:${token}`);
        if (infoStr) {
          const info = JSON.parse(infoStr);
          if (info?.userId) {
            const isMember = await this.getIsMember(info.userId);
            return { userId: info.userId, isMember };
          }
        }
      } catch {
        /* 解析失败则降级为游客 */
      }
    }
    const fwd = this.ctx.headers['x-forwarded-for'] as string;
    const ip = (fwd ? fwd.split(',')[0].trim() : '') || this.ctx.ip || 'anonymous';
    return { userId: `guest:${ip}`, isMember: false };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 问答配额查询',
    functionName: 'aiQuota',
    name: 'aiQuota',
    path: '/api/ai/quota',
    method: 'get',
  })
  @NoAuth()
  async aiQuota() {
    const { userId, isMember } = await this.resolveUser();
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
  @NoAuth()
  async aiChat(@Body(ALL) body: AIChatDTO) {
    const { userId, isMember } = await this.resolveUser();
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
  @NoAuth()
  async aiChatStream(@Body(ALL) body: AIChatDTO) {
    const { userId, isMember } = await this.resolveUser();

    this.ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
    this.ctx.set('Cache-Control', 'no-cache');
    this.ctx.set('Connection', 'keep-alive');
    this.ctx.set('X-Accel-Buffering', 'no');
    // 绕过 Midway/Koa 的响应序列化，手写 SSE 流（ctx.respond 不在 faas 类型上）
    (this.ctx as any).respond = false;

    const res = this.ctx.res;

    try {
      // 限流放在流内：超限时以 SSE error 帧返回，前端可识别 RATE_LIMIT
      await this.aiProxyService.checkRateLimit(userId, isMember);

      const gen = this.aiProxyService.forwardStream(
        body.messages,
        body.context,
        userId
      );

      for await (const chunk of gen) {
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }
    } catch (err: any) {
      res.write(
        `data: ${JSON.stringify({ error: err?.message || 'AI 请求失败' })}\n\n`
      );
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}
