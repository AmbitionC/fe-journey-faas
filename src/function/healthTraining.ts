import { Provide, ServerlessTrigger, ServerlessTriggerType, Inject, Config, Query, Body, ALL } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';
import { HealthTrainingService } from '../service/health/training/service';

/**
 * 力量训练 API（/health/training/*、/health/exercise/*）：12 周计划 + 记组 + 动作库。
 * 鉴权同健康模块：X-Health-Token。
 */
@Provide()
export class HealthTrainingHTTPService {
  @Inject()
  ctx: Context;

  @Config('health')
  healthConfig: { apiToken: string };

  @Inject()
  training: HealthTrainingService;

  private assertToken() {
    const expected = this.healthConfig?.apiToken;
    if (!expected) throw R.forbiddenError('健康模块未配置访问令牌（HEALTH_API_TOKEN）');
    const headers: any = (this.ctx as any).headers || (this.ctx as any).header || {};
    const got = headers['x-health-token'] || (headers.authorization || '').replace('Bearer ', '');
    if (got !== expected) throw R.unauthorizedError('健康模块令牌无效');
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/training/today', method: 'get', functionName: 'healthTrainingToday', name: 'healthTrainingToday', description: '今天练什么（处方 + 已记组 + 计划概览）' })
  @NoAuth()
  async today() {
    this.assertToken();
    return { success: true, data: await this.training.today() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/training/start', method: 'post', functionName: 'healthTrainingStart', name: 'healthTrainingStart', description: '开始/重新开始 12 周计划' })
  @NoAuth()
  async start(@Body(ALL) body: { startDate?: string }) {
    this.assertToken();
    return { success: true, data: await this.training.start(body?.startDate) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/training/log', method: 'post', functionName: 'healthTrainingLog', name: 'healthTrainingLog', description: '记一组（reps=0 删除）' })
  @NoAuth()
  async log(@Body(ALL) body: any) {
    this.assertToken();
    return { success: true, data: await this.training.logSet(body || {}) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/training/swap', method: 'post', functionName: 'healthTrainingSwap', name: 'healthTrainingSwap', description: '某槽位换动作（当前阶段）' })
  @NoAuth()
  async swap(@Body(ALL) body: any) {
    this.assertToken();
    return { success: true, data: await this.training.swap(body || {}) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/training/history', method: 'get', functionName: 'healthTrainingHistory', name: 'healthTrainingHistory', description: '训练记录（按天）' })
  @NoAuth()
  async history(@Query(ALL) q: { days?: string }) {
    this.assertToken();
    const h = await this.training.history(Math.min(365, Math.max(7, Number(q?.days) || 60)));
    return { success: true, data: h.reverse() };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/exercise/detail', method: 'get', functionName: 'healthExerciseDetail', name: 'healthExerciseDetail', description: '动作详情 + 替代动作' })
  @NoAuth()
  async exercise(@Query(ALL) q: { id?: string; slot?: string }) {
    this.assertToken();
    return { success: true, data: this.training.exercise(String(q?.id || ''), q?.slot || undefined) };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/exercise/search', method: 'get', functionName: 'healthExerciseSearch', name: 'healthExerciseSearch', description: '动作库搜索' })
  @NoAuth()
  async search(@Query(ALL) q: { q?: string; part?: string; eq?: string }) {
    this.assertToken();
    return { success: true, data: this.training.search(q || {}) };
  }
}
