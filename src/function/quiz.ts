import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { QuizService } from '../service/quiz';
import { ArticleService } from '../service/article';
import { RetrieveService } from '../service/ai/retrieve';
import { AgentService } from '../service/ai/agent';
import { UserEntity } from '../entity/user';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';
import {
  QuizListQueryDTO,
  QuizSubmitDTO,
  QuizSaveDTO,
  QuizDeleteDTO,
  QuizAdminListQueryDTO,
  QuizDetailQueryDTO,
  QuizGenerateDTO,
  ReviewDueQueryDTO,
  ReviewFeedbackDTO,
} from '../dto/quiz';

@Provide()
export class QuizHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  quizService: QuizService;

  @Inject()
  articleService: ArticleService;

  @Inject()
  retrieveService: RetrieveService;

  @Inject()
  agentService: AgentService;

  @Inject()
  redisService: RedisService;

  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  private async getIsMember(userId: string): Promise<boolean> {
    try {
      const user = await this.userModel.findOneBy({ phoneNumber: userId });
      if (!user?.isMember || !user?.memberDate) return false;
      return new Date(user.memberDate) > new Date();
    } catch {
      return false;
    }
  }

  /** 解析身份：登录用户→真实 id+会员判断；游客→以 IP 标识、非会员。 */
  private async resolveUser(): Promise<{ userId: string; isMember: boolean }> {
    const header = (this.ctx.header || {}) as any;
    const token = header.token || header.authorization?.replace('Bearer ', '');
    if (token) {
      try {
        const s = await this.redisService.get(`token:${token}`);
        if (s) {
          const info = JSON.parse(s);
          if (info?.userId) {
            return { userId: info.userId, isMember: await this.getIsMember(info.userId) };
          }
        }
      } catch {
        /* 降级游客 */
      }
    }
    const fwd = this.ctx.headers['x-forwarded-for'] as string;
    const ip = (fwd ? fwd.split(',')[0].trim() : '') || this.ctx.ip || 'anonymous';
    return { userId: `guest:${ip}`, isMember: false };
  }

  private requireLogin() {
    const userId = this.ctx.userInfo?.userId;
    if (!userId) throw R.unauthorizedError('请先登录后再操作');
    return userId;
  }

  // ========== 用户端 ==========

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取某文章的测验题（已发布，剥离答案）',
    functionName: 'getQuizList',
    name: 'getQuizList',
    path: '/article/quiz/list',
    method: 'get',
  })
  @NoAuth()
  async list(@Query(ALL) query: QuizListQueryDTO) {
    const list = await this.quizService.listForTake(query.module, query.articleKey);
    return { success: true, data: { list } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '提交测验作答（判分+回流+建议）',
    functionName: 'submitQuiz',
    name: 'submitQuiz',
    path: '/article/quiz/submit',
    method: 'post',
  })
  @NoAuth()
  async submit(@Body(ALL) body: QuizSubmitDTO) {
    const { userId, isMember } = await this.resolveUser();
    const data = await this.quizService.submit({
      userId: userId || body.userId || `guest:anonymous`,
      isMember,
      module: body.module,
      articleKey: body.articleKey,
      answers: body.answers || [],
      durationMs: body.durationMs,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '待复习清单（含到期原因/优先级）',
    functionName: 'getReviewDue',
    name: 'getReviewDue',
    path: '/article/review/due',
    method: 'get',
  })
  @NoAuth()
  async reviewDue(@Query(ALL) query: ReviewDueQueryDTO) {
    const { userId } = await this.resolveUser();
    const uid = userId || query.userId || '';
    if (!uid) return { success: true, data: { list: [] } };
    const profile = await this.articleService.getLearnerProfile(uid, query.module);
    return { success: true, data: { list: profile.reviewDueDetail } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '复习反馈（更新间隔重复排程）',
    functionName: 'reviewFeedback',
    name: 'reviewFeedback',
    path: '/article/review/feedback',
    method: 'post',
  })
  @NoAuth()
  async reviewFeedback(@Body(ALL) body: ReviewFeedbackDTO) {
    const { userId } = await this.resolveUser();
    const uid = userId || body.userId || '';
    if (!uid) return { success: true, data: {} };
    const data = await this.articleService.updateSchedule(
      uid,
      body.module,
      body.articleKey,
      body.result
    );
    // 复习反馈也回流掌握度：again→review，其余→至少 review/mastered
    const target = body.result === 'again' ? 'review' : body.result === 'easy' ? 'mastered' : 'review';
    await this.articleService.reflowMastery(uid, body.module, body.articleKey, target as any, 'atLeast');
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '能力雷达（按一级分类的掌握度）',
    functionName: 'capabilityRadar',
    name: 'capabilityRadar',
    path: '/article/radar',
    method: 'get',
  })
  @NoAuth()
  async radar(@Query(ALL) query: ReviewDueQueryDTO) {
    const { userId } = await this.resolveUser();
    const uid = userId || query.userId || '';
    if (!uid) return { success: true, data: { dimensions: [] } };
    const dimensions = await this.articleService.getCapabilityRadar(uid, query.module);
    return { success: true, data: { dimensions } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '跨模块补学推荐（薄弱点 → 知识库文章）',
    functionName: 'crossRecommend',
    name: 'crossRecommend',
    path: '/article/recommendations',
    method: 'get',
  })
  @NoAuth()
  async recommendations(@Query(ALL) query: ReviewDueQueryDTO) {
    const { userId } = await this.resolveUser();
    const uid = userId || query.userId || '';
    if (!uid) return { success: true, data: { list: [] } };
    const profile = await this.articleService.getLearnerProfile(uid, query.module);
    const weak = (profile?.weakTags || []).slice(0, 3);
    const list = [];
    for (const w of weak) {
      const articles = await this.retrieveService.retrieve(w.tag, {
        module: 'knowledge',
        topK: 2,
      });
      if (articles.length) list.push({ tag: w.tag, articles });
    }
    return { success: true, data: { list } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '编排式 Agent：查→出题→记录→提醒 小闭环',
    functionName: 'agentStudyPlan',
    name: 'agentStudyPlan',
    path: '/article/agent/studyPlan',
    method: 'post',
  })
  async agentStudyPlan(@Body(ALL) body: QuizListQueryDTO) {
    const userId = this.requireLogin();
    const data = await this.agentService.runStudyPlan({
      userId,
      module: body.module,
      articleKey: body.articleKey,
    });
    return { success: true, data };
  }

  // ========== 管理端（需登录 token） ==========

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '管理端题目列表',
    functionName: 'adminQuizList',
    name: 'adminQuizList',
    path: '/article/quiz/adminList',
    method: 'get',
  })
  async adminList(@Query(ALL) query: QuizAdminListQueryDTO) {
    this.requireLogin();
    const data = await this.quizService.adminList(query);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '管理端题目详情',
    functionName: 'quizDetail',
    name: 'quizDetail',
    path: '/article/quiz/detail',
    method: 'get',
  })
  async detail(@Query(ALL) query: QuizDetailQueryDTO) {
    this.requireLogin();
    const data = await this.quizService.getById(query.id);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 基于文章自动出题（入库为草稿）',
    functionName: 'generateQuiz',
    name: 'generateQuiz',
    path: '/article/quiz/generate',
    method: 'post',
  })
  async generate(@Body(ALL) body: QuizGenerateDTO) {
    const userId = this.requireLogin();
    const data = await this.quizService.generate({
      userId,
      module: body.module,
      articleKey: body.articleKey,
      count: body.count,
      types: body.types,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '创建/更新题目',
    functionName: 'saveQuiz',
    name: 'saveQuiz',
    path: '/article/quiz/save',
    method: 'post',
  })
  async save(@Body(ALL) body: QuizSaveDTO) {
    this.requireLogin();
    const data = await this.quizService.saveQuestion(body as any);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除题目',
    functionName: 'deleteQuiz',
    name: 'deleteQuiz',
    path: '/article/quiz/delete',
    method: 'post',
  })
  async remove(@Body(ALL) body: QuizDeleteDTO) {
    this.requireLogin();
    const data = await this.quizService.deleteQuestion(body.id);
    return { success: true, data };
  }
}
