import { Provide, ServerlessTrigger, ServerlessTriggerType, Inject, Config, Query, Body, ALL } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';
import { HealthTrainingService } from '../service/health/training/service';
import { OpenGymService } from '../service/health/training/opengymService';

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

  @Inject()
  openGym: OpenGymService;

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

  /**
   * openGym App「设置 › 导出备份（JSON）」→ 分享给快捷指令 → POST 整份备份（请求体就是那个文件）。
   * ?format=text 直接回一段中文摘要，快捷指令「显示结果」即可。
   */
  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/opengym/sync', method: 'post', functionName: 'healthOpenGymSync', name: 'healthOpenGymSync', description: 'openGym 备份同步（组/课/时间段）' })
  @NoAuth()
  async openGymSync(@Body(ALL) body: any, @Query(ALL) q: { format?: string }) {
    this.assertToken();
    let state = body;
    if (typeof state === 'string') state = JSON.parse(state);
    if (state && state.state && Array.isArray(state.state.workouts)) state = state.state; // /api/data 的 {state, rev} 也收
    const r = await this.openGym.sync(state);
    if (q?.format === 'text') {
      this.ctx.set('Content-Type', 'text/plain; charset=utf-8');
      return r.text;
    }
    return { success: true, data: r };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/opengym/status', method: 'get', functionName: 'healthOpenGymStatus', name: 'healthOpenGymStatus', description: 'openGym 最近同步' })
  @NoAuth()
  async openGymStatus() {
    this.assertToken();
    return { success: true, data: await this.openGym.status() };
  }

  /** 12 周计划 → openGym 计划文件（phase=1–3，缺省当前阶段）；返回的就是文件内容本身。 */
  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/health/opengym/plan', method: 'get', functionName: 'healthOpenGymPlan', name: 'healthOpenGymPlan', description: '导出 openGym 计划文件' })
  @NoAuth()
  async openGymPlan(@Query(ALL) q: { phase?: string }) {
    this.assertToken();
    const f = await this.openGym.plan(q?.phase ? Number(q.phase) : undefined);
    this.ctx.set('Content-Disposition', `attachment; filename="opengym-plan-${f.routines[0].id.slice(-2)}.json"`);
    return f;
  }
}
