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
import { AiProxyService, ChatMessage, ChatContext, AiTask } from '../service/ai/proxy';
import { AiHistoryService } from '../service/ai/history';
import { RetrieveService } from '../service/ai/retrieve';
import { ArticleService } from '../service/article';
import { GradeItem } from '../service/ai/prompts';
import { isEntitled } from '../common/entitlement';
import { UserEntity } from '../entity/user';
import { NoAuth } from '../decorator/noAuth';

class AIChatDTO {
  messages: ChatMessage[];
  context: ChatContext;
  conversationId?: number;
  /** 深度思考开关（默认开启；走 DeepSeek reasoner 返回思考链） */
  deepThink?: boolean;
  /** 结构化任务（算法提示/点评）：存在时提示词由服务端拼装 */
  task?: AiTask;
}

class AIHintDTO {
  title: string;
  description: string;
  code?: string;
  language?: string;
  level: 1 | 2 | 3 | 4;
}

class AIReviewDTO {
  title: string;
  code: string;
  language?: string;
  resultSummary?: string;
}

class AIRetrieveDTO {
  query: string;
  module?: string;
  topK?: number;
}

class AIQuizGradeDTO {
  items: GradeItem[];
  module?: string;
  articleKey?: string;
}

class AICoachTipDTO {
  module: string;
  articleKey?: string;
  title?: string;
}

class AICoachWeeklyDTO {
  module: string;
}

class AIInterviewDTO {
  topic: string;
  history?: { role: 'interviewer' | 'candidate'; content: string }[];
  mode?: 'ask' | 'evaluate';
}

class AIConversationDTO {
  action: 'list' | 'messages' | 'rename' | 'delete';
  conversationId?: number;
  title?: string;
  page?: number;
  pageSize?: number;
}

@Provide()
export class AiHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  aiProxyService: AiProxyService;

  @Inject()
  aiHistoryService: AiHistoryService;

  @Inject()
  retrieveService: RetrieveService;

  @Inject()
  articleService: ArticleService;

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

    // RAG：召回站内资料注入上下文（PRD-02 F1-1/F1-2）
    let citations: { title: string; articleKey: string; module: string }[] = [];
    try {
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
      if (lastUser?.content) {
        const hits = await this.retrieveService.retrieve(lastUser.content, {
          module: body.context?.module,
          topK: 3,
        });
        if (hits.length) {
          citations = hits.map((h) => ({
            title: h.title,
            articleKey: h.articleKey,
            module: h.module,
          }));
          body.context = {
            ...body.context,
            ragContext: hits
              .map((h, i) => `[${i + 1}] 《${h.title}》(articleKey=${h.articleKey}, module=${h.module})`)
              .join('\n'),
          };
        }
      }
    } catch {
      /* 检索失败不影响回答 */
    }

    const content = await this.aiProxyService.forward(
      body.messages,
      body.context,
      userId
    );

    // 持久化为会话历史（尽力而为，失败不影响回答）
    let conversationId: number | undefined;
    try {
      const lastUser = [...(body.messages || [])]
        .reverse()
        .find((m) => m.role === 'user');
      const conv = await this.aiHistoryService.ensureConversation(
        userId,
        body.conversationId,
        {
          module: body.context?.module,
          articleKey: body.context?.articleKey,
          firstUserText: lastUser?.content,
        }
      );
      if (lastUser) {
        await this.aiHistoryService.appendMessage(conv, {
          role: 'user',
          content: lastUser.content,
        });
      }
      await this.aiHistoryService.appendMessage(conv, {
        role: 'assistant',
        content,
      });
      conversationId = conv.id as any;
    } catch (e) {
      this.ctx.logger?.warn?.('[ai] persist conversation failed', e);
    }

    return { success: true, content, conversationId, citations };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 会话管理（列表/历史/改名/删除）',
    functionName: 'aiConversation',
    name: 'aiConversation',
    path: '/api/ai/conversation',
    method: 'post',
  })
  @NoAuth()
  async aiConversation(@Body(ALL) body: AIConversationDTO) {
    const { userId } = await this.resolveUser();
    const needId = () => {
      if (!body.conversationId) {
        this.ctx.status = 400;
        return false;
      }
      return true;
    };

    switch (body.action) {
      case 'list':
        return {
          success: true,
          data: await this.aiHistoryService.listConversations(
            userId,
            body.page,
            body.pageSize
          ),
        };
      case 'messages':
        if (!needId()) return { success: false, message: 'conversationId 必填' };
        return {
          success: true,
          data: await this.aiHistoryService.listMessages(
            userId,
            body.conversationId
          ),
        };
      case 'rename':
        if (!needId()) return { success: false, message: 'conversationId 必填' };
        return {
          success: true,
          data: await this.aiHistoryService.rename(
            userId,
            body.conversationId,
            body.title || ''
          ),
        };
      case 'delete':
        if (!needId()) return { success: false, message: 'conversationId 必填' };
        return {
          success: true,
          data: await this.aiHistoryService.softDelete(
            userId,
            body.conversationId
          ),
        };
      default:
        this.ctx.status = 400;
        return { success: false, message: '未知 action' };
    }
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

      const gen = body.task
        ? this.aiProxyService.forwardTaskStream(body.task, userId, body.deepThink !== false)
        : this.aiProxyService.forwardStream(
            body.messages,
            body.context,
            userId,
            body.deepThink !== false
          );

      for await (const chunk of gen) {
        if (chunk && chunk.reasoning) {
          res.write(`data: ${JSON.stringify({ reasoning: chunk.reasoning })}\n\n`);
        }
        if (chunk && chunk.content) {
          res.write(`data: ${JSON.stringify({ content: chunk.content })}\n\n`);
        }
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

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '算法分层提示（提示词服务端拼装，不剧透）',
    functionName: 'aiHint',
    name: 'aiHint',
    path: '/api/ai/hint',
    method: 'post',
  })
  @NoAuth()
  async aiHint(@Body(ALL) body: AIHintDTO) {
    const { userId, isMember } = await this.resolveUser();
    await this.aiProxyService.checkRateLimit(userId, isMember);
    const content = await this.aiProxyService.hint(body, userId);
    return { success: true, data: { content } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '代码点评（约束服务端拼装）',
    functionName: 'aiReview',
    name: 'aiReview',
    path: '/api/ai/review',
    method: 'post',
  })
  @NoAuth()
  async aiReview(@Body(ALL) body: AIReviewDTO) {
    const { userId, isMember } = await this.resolveUser();
    await this.aiProxyService.checkRateLimit(userId, isMember);
    const content = await this.aiProxyService.review(body, userId);
    return { success: true, data: { content } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '站内内容检索（调试/内部）',
    functionName: 'aiRetrieve',
    name: 'aiRetrieve',
    path: '/api/ai/retrieve',
    method: 'post',
  })
  @NoAuth()
  async aiRetrieve(@Body(ALL) body: AIRetrieveDTO) {
    const items = await this.retrieveService.retrieve(body.query, {
      module: body.module,
      topK: body.topK,
    });
    return { success: true, data: { items } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '简答判分 + 定制化建议（会员含深度建议）',
    functionName: 'aiQuizGrade',
    name: 'aiQuizGrade',
    path: '/api/ai/quiz/grade',
    method: 'post',
  })
  @NoAuth()
  async aiQuizGrade(@Body(ALL) body: AIQuizGradeDTO) {
    const { userId, isMember } = await this.resolveUser();
    await this.aiProxyService.checkRateLimit(userId, isMember);
    const member = isEntitled('personalized_feedback', { isMember });

    let candidates: { title: string; articleKey: string }[] = [];
    let profileSummary = '';
    if (member) {
      const query =
        (body.items || []).map((i) => i.stem).join(' ') ||
        (body.articleKey || '').replace(/[-_]/g, ' ');
      const hits = await this.retrieveService.retrieve(query, {
        module: body.module,
        topK: 5,
      });
      candidates = hits.map((h) => ({ title: h.title, articleKey: h.articleKey }));
      if (body.module) {
        profileSummary = await this.articleService.getProfileSummary(userId, body.module);
      }
    }
    const data = await this.aiProxyService.gradeSubmission(
      { items: body.items || [], member, profileSummary, candidates },
      userId
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '主动教练：进入文章的个性化一句提示',
    functionName: 'aiCoachTip',
    name: 'aiCoachTip',
    path: '/api/ai/coach/tip',
    method: 'post',
  })
  @NoAuth()
  async aiCoachTip(@Body(ALL) body: AICoachTipDTO) {
    const { userId } = await this.resolveUser();
    // 游客或零学习记录不打扰
    if (!userId || userId.startsWith('guest:')) return { success: true, data: { tip: '' } };

    // 缓存：同一用户同一文章每天最多生成一次，避免每次打开都调用 LLM
    const cacheKey = `coachtip:${userId}:${body.module}:${body.articleKey || ''}`;
    try {
      const cached = await this.redisService.get(cacheKey);
      if (cached !== null && cached !== undefined) {
        return { success: true, data: { tip: cached } };
      }
    } catch {
      /* 缓存读失败则照常生成 */
    }

    const profile = await this.articleService.getLearnerProfile(userId, body.module);
    if (!profile || profile.coverage.done <= 0) return { success: true, data: { tip: '' } };
    const summary = await this.articleService.getProfileSummary(userId, body.module);
    const tip = await this.aiProxyService.coachTip(
      {
        profileSummary: summary,
        weakTags: (profile.weakTags || []).map((w) => w.tag),
        articleTitle: body.title,
      },
      userId
    );
    try {
      // 即使为空串也缓存，避免反复空跑（TTL 1 天）
      await this.redisService.set(cacheKey, tip || '', 'EX', 86400);
    } catch {
      /* ignore */
    }
    return { success: true, data: { tip } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '主动教练：学习周报文案',
    functionName: 'aiCoachWeekly',
    name: 'aiCoachWeekly',
    path: '/api/ai/coach/weekly',
    method: 'post',
  })
  @NoAuth()
  async aiCoachWeekly(@Body(ALL) body: AICoachWeeklyDTO) {
    const { userId } = await this.resolveUser();
    if (!userId) return { success: true, data: { report: '' } };
    const profile = await this.articleService.getLearnerProfile(userId, body.module);
    const summary = await this.articleService.getProfileSummary(userId, body.module);
    const report = await this.aiProxyService.weeklyReport(
      {
        profileSummary: summary,
        weakTags: (profile?.weakTags || []).map((w) => w.tag),
        reviewDueCount: profile?.reviewDue?.length || 0,
        streak: profile?.streak || 0,
      },
      userId
    );
    return { success: true, data: { report } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 模拟面试（会员）',
    functionName: 'aiInterview',
    name: 'aiInterview',
    path: '/api/ai/interview',
    method: 'post',
  })
  @NoAuth()
  async aiInterview(@Body(ALL) body: AIInterviewDTO) {
    const { userId, isMember } = await this.resolveUser();
    // 会员权益网关：非会员返回付费入口标记
    if (!isEntitled('mock_interview', { isMember })) {
      return { success: true, data: { paywall: true, message: '开通会员解锁 AI 模拟面试' } };
    }
    await this.aiProxyService.checkRateLimit(userId, isMember);
    const reply = await this.aiProxyService.interview(
      {
        topic: body.topic || '前端综合',
        history: body.history || [],
        mode: body.mode || (body.history?.length ? 'evaluate' : 'ask'),
      },
      userId
    );
    return { success: true, data: { reply } };
  }
}
