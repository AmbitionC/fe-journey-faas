import { MidwayConfig } from '@midwayjs/core';
import * as redisStore from 'cache-manager-ioredis';
import { UserEntity } from '../entity/user';
import { InterviewEntity } from '../entity/interview';
import { VisitLogEntity } from '../entity/visitLog';
import { OrderEntity } from '../entity/order';
import { NavConfigEntity } from '../entity/navConfig';
import { ArticleEntity } from '../entity/article';
import { UserArticleActionEntity } from '../entity/userArticleAction';
import { ArticleViewLogEntity } from '../entity/articleViewLog';
import { AlgorithmProblemEntity } from '../entity/algorithm/problem';
import { AlgorithmTestCaseEntity } from '../entity/algorithm/testCase';
import { AlgorithmTagEntity } from '../entity/algorithm/tag';
import { AlgorithmProblemTagEntity } from '../entity/algorithm/problemTag';
import { AlgorithmSubmissionEntity } from '../entity/algorithm/submission';
import { AlgorithmCodeDraftEntity } from '../entity/algorithm/codeDraft';
import { AlgorithmProblemFlagEntity } from '../entity/algorithm/problemFlag';
import { ArticleAnnotationEntity } from '../entity/articleAnnotation';
import { BookEntity } from '../entity/book';
import { BookOrderEntity } from '../entity/bookOrder';
import { AiUsageLogEntity } from '../entity/aiUsageLog';
import { AiConversationEntity } from '../entity/aiConversation';
import { AiMessageEntity } from '../entity/aiMessage';
import { ArticleReadingStateEntity } from '../entity/articleReadingState';
import { QuizQuestionEntity } from '../entity/quizQuestion';
import { QuizAttemptEntity } from '../entity/quizAttempt';
import { ReviewScheduleEntity } from '../entity/reviewSchedule';
import { EventLogEntity } from '../entity/eventLog';
import { AiCallLogEntity } from '../entity/aiCallLog';
import { EvalReportEntity } from '../entity/evalReport';
import { GrowthStatEntity } from '../entity/growthStat';
import { GrowthReviewEntity } from '../entity/growthReview';
import { UserGoalEntity } from '../entity/userGoal';
import { LearningPathEntity } from '../entity/learningPath';
import { NotifySubscriptionEntity } from '../entity/notifySubscription';
import {
  OpsTaskEntity,
  ContentHealthReportEntity,
  OpsAuditLogEntity,
  SamplingCheckEntity,
  OpsReviewEntity,
} from '../entity/ops';
import { join } from 'path';
import { readFileSync } from 'fs';

// 本地开发：从 .env.local / .env 读取变量到 process.env（两者均已 gitignore）。
// 生产环境由 FC 环境变量注入，不依赖此文件。需在读取下方 env 常量前执行。
(() => {
  for (const f of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(`${process.cwd()}/${f}`, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
    } catch {
      /* 文件不存在时忽略 */
    }
  }
})();

// PRD-07：数据库/Redis 凭证只从环境变量读取，不在代码中保留任何明文兜底。
// 本地开发：在 .env.local 配置（见 .env.example）；生产：FC 函数环境变量注入。
const DB_HOST = process.env.DB_HOST || '';
const DB_USER = process.env.DB_USER || '';
const DB_PASS = process.env.DB_PASS || '';
const REDIS_HOST = process.env.REDIS_HOST || '';
const REDIS_PASS = process.env.REDIS_PASS || '';

export default {
  cors: {
    credentials: true,
    origin: (ctx) => ctx.get('origin') || '*',
    allowMethods: 'GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS',
    allowHeaders: 'Content-Type,Authorization,Accept,token,X-Health-Token',
  },
  token: {
    expire: 60 * 60 * 24 * 7,
  },
  // 投资数据库：表结构由 invest-model(Python/SQLAlchemy) 唯一拥有。
  // 不注册进 typeorm.dataSource——那样会在应用启动时强制连接，一旦 invest 库
  // 不可达会拖垮整个函数（含登录/验证码等原有功能）。改由 InvestDbService
  // 惰性初始化：首次 /invest/* 请求才连接，失败只影响当次请求。
  investDb: {
    host: DB_HOST,
    port: 3306,
    username: DB_USER,
    password: DB_PASS,
    database: process.env.INVEST_DB_NAME || 'invest',
  },
  // 个人健康管理模块（/health/*）：独立库 + 惰性连接（HealthDbService），
  // 与 investDb 同一解耦模式——不注册全局数据源，库不可达只影响 /health/* 请求。
  healthDb: {
    host: DB_HOST,
    port: 3306,
    username: DB_USER,
    password: DB_PASS,
    database: process.env.HEALTH_DB_NAME || 'health',
  },
  health: {
    // 独立访问令牌（前端 + iOS 快捷指令共用）。为空时模块拒绝所有请求。
    apiToken: process.env.HEALTH_API_TOKEN || '',
    // 拍照识别热量：OpenAI 兼容的视觉模型（如 qwen-vl-max / gpt-4o）。未配置则该功能降级。
    vision: {
      baseUrl:
        process.env.HEALTH_VISION_BASE_URL ||
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: process.env.HEALTH_VISION_API_KEY || '',
      model: process.env.HEALTH_VISION_MODEL || '',
    },
    // 饮食建议文本模型：默认复用全站 LLM 配置（deepseek）。
    chat: {
      baseUrl:
        process.env.HEALTH_CHAT_BASE_URL ||
        (process.env.LLM_PROVIDER === 'openai'
          ? 'https://api.openai.com/v1'
          : 'https://api.deepseek.com'),
      apiKey: process.env.HEALTH_CHAT_API_KEY || process.env.LLM_API_KEY || '',
      model: process.env.HEALTH_CHAT_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash',
    },
  },
  typeorm: {
    dataSource: {
      default: {
        type: 'mysql',
        host: DB_HOST,
        port: 3306,
        allowPublicKeyRetrieval: true,
        username: DB_USER,
        password: DB_PASS,
        database: 'fe-journey',
        charset: 'utf8mb4',
        synchronize: true,
        logging: true,
        entities: [
          UserEntity, InterviewEntity, VisitLogEntity, OrderEntity, NavConfigEntity,
          ArticleEntity, UserArticleActionEntity, ArticleViewLogEntity,
          AlgorithmProblemEntity, AlgorithmTestCaseEntity, AlgorithmTagEntity,
          AlgorithmProblemTagEntity, AlgorithmSubmissionEntity, AlgorithmCodeDraftEntity,
          AlgorithmProblemFlagEntity,
          ArticleAnnotationEntity, BookEntity, BookOrderEntity, AiUsageLogEntity,
          AiConversationEntity, AiMessageEntity, ArticleReadingStateEntity,
          QuizQuestionEntity, QuizAttemptEntity, ReviewScheduleEntity,
          EventLogEntity, AiCallLogEntity, UserGoalEntity, LearningPathEntity,
          NotifySubscriptionEntity,
          OpsTaskEntity, ContentHealthReportEntity, OpsAuditLogEntity, SamplingCheckEntity,
          OpsReviewEntity, EvalReportEntity,
          GrowthStatEntity, GrowthReviewEntity,
        ],
      },
    },
  },
  judge0: {
    apiUrl: process.env.JUDGE0_API_URL || 'https://judge0-ce.p.rapidapi.com',
    apiKey: process.env.JUDGE0_API_KEY || '',
    timeout: 10,
    memoryLimit: 128000,
  },
  redis: {
    client: {
      port: 6379,
      host: REDIS_HOST,
      password: REDIS_PASS,
      db: 0,
    },
  },
  cache: {
    store: redisStore,
    options: {
      host: REDIS_HOST,
      password: REDIS_PASS,
      port: 6379,
      db: 0,
      keyPrefix: 'cache:',
      ttl: 100,
    },
  },
  captcha: {
    expirationTime: 3600,
    idPrefix: 'captcha',
  },
  swagger: {
    title: 'Fe Journey API',
    description: 'Fe Journey API 文档',
    version: '1.0.0',
    enableOpenApi: true,
    swaggerPath: '/swagger-ui',
  },
  staticFile: {
    dirs: {
      default: {
        prefix: '/',
        dir: join(__dirname, '../public'),
      },
    },
  },
  ai: {
    provider: process.env.LLM_PROVIDER || 'deepseek',
    apiKey: process.env.LLM_API_KEY || '',
    // deepseek-chat / deepseek-reasoner 于 2026-07-24 弃用，统一切 deepseek-v4-flash（非思考=chat、思考=reasoner 均由它承载，思考走请求体 thinking 参数，见 proxy.buildRequestBody）。生产可用 LLM_MODEL 覆盖（如 deepseek-v4-pro）。
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    rateLimit: {
      freeUserPerDay: parseInt(process.env.AI_RATE_FREE || '10', 10),
      freeWindowSeconds: 86400,
    },
  },
  // 限时免费开关：开启时所有人按会员对待（AI 无限、模拟面试解锁、项目实战全开、隐藏付费入口）。
  // 将来恢复收费：设环境变量 MEMBERSHIP_FREE=false 即可，无需改代码。
  membership: {
    freeForAll: process.env.MEMBERSHIP_FREE !== 'false',
  },
  syncSecret: process.env.SYNC_SECRET,
} as MidwayConfig;
