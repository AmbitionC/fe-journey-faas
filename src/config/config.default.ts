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
import { ArticleAnnotationEntity } from '../entity/articleAnnotation';
import { BookEntity } from '../entity/book';
import { BookOrderEntity } from '../entity/bookOrder';
import { AiUsageLogEntity } from '../entity/aiUsageLog';
import { join } from 'path';

const DB_HOST = process.env.DB_HOST || 'rm-bp18fm5u5c7uk47558o.mysql.rds.aliyuncs.com';
const DB_USER = process.env.DB_USER || 'ch17394940726';
const DB_PASS = process.env.DB_PASS || '';
const REDIS_HOST = process.env.REDIS_HOST || 'r-bp1bwq5o4hpvnfwfbzpd.redis.rds.aliyuncs.com';
const REDIS_PASS = process.env.REDIS_PASS || '';

export default {
  cors: {
    credentials: true,
    origin: (ctx) => ctx.get('origin') || '*',
    allowMethods: 'GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS',
    allowHeaders: 'Content-Type,Authorization,Accept,token',
  },
  token: {
    expire: 60 * 60 * 24 * 7,
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
          ArticleAnnotationEntity, BookEntity, BookOrderEntity, AiUsageLogEntity,
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
    provider: process.env.LLM_PROVIDER || 'qwen',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'qwen-max',
    rateLimit: {
      freeUserPerHour: parseInt(process.env.AI_RATE_FREE || '30', 10),
      memberPerHour: parseInt(process.env.AI_RATE_MEMBER || '200', 10),
      windowSeconds: 3600,
    },
  },
} as MidwayConfig;
