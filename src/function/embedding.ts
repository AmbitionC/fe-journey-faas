import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  Query,
  ALL,
  Config,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { EmbeddingService } from '../service/embedding';
import { assertAdmin } from '../common/admin.guard';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';

@Provide()
export class EmbeddingHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  embeddingService: EmbeddingService;

  @Config('journey')
  journeyConfig: { embeddingEnabled: boolean };

  private ensureEnabled(): void {
    if (!this.journeyConfig?.embeddingEnabled) throw R.error('embedding 功能尚未开放');
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '全量回填文章向量（管理员，阶段2）',
    functionName: 'embeddingBackfill',
    name: 'embeddingBackfill',
    path: '/embedding/backfill',
    method: 'post',
  })
  @NoAuth()
  async backfill(@Body(ALL) body: { modules?: string[] }) {
    await assertAdmin(this.ctx, this.redisService);
    this.ensureEnabled();
    const data = await this.embeddingService.backfillContent(body?.modules);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '面经题聚类（管理员，重跑幂等）',
    functionName: 'interviewCluster',
    name: 'interviewCluster',
    path: '/interview/cluster',
    method: 'post',
  })
  @NoAuth()
  async cluster(@Body(ALL) body: { items?: any[]; threshold?: number }) {
    await assertAdmin(this.ctx, this.redisService);
    this.ensureEnabled();
    const data = await this.embeddingService.clusterInterview(body?.items, body?.threshold);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '公司高频问题 TOP N（xxx 公司最爱问什么）',
    functionName: 'interviewCompanyTop',
    name: 'interviewCompanyTop',
    path: '/interview/company-top',
    method: 'get',
  })
  @NoAuth()
  async companyTop(@Query('company') company: string, @Query('n') n: string) {
    // 只读展示，游客可看；聚类结果已脱敏
    const data = await this.embeddingService.companyTop(company || '', Number(n) || 10);
    return { success: true, data };
  }
}
