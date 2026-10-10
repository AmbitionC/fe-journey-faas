import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Config,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';
import { PosDashboardService } from '../service/pos/dashboard';
import { PosAlertService } from '../service/pos/alertPush';
import { PosReviewService } from '../service/pos/reviewService';
import { PosFinanceService } from '../service/pos/finance';
import { PosContextService, MANUAL_METRICS } from '../service/pos/context';
import { todayCN } from '../service/pos/logic';

type Ep = { baseUrl: string; apiKey: string; model: string };

/**
 * Personal OS API（/pos/*）：个人上下文库 + 跨域看板聚合。
 *
 * 与主站用户体系完全解耦：@NoAuth 跳过登录中间件，复用健康模块的 X-Health-Token
 * （同一个人、同一前端、同一 iOS 快捷指令）。HEALTH_API_TOKEN 未配置时一律拒绝。
 */
@Provide()
export class PosHTTPService {
  @Inject()
  ctx: Context;

  @Config('health')
  healthConfig: { apiToken: string; vision: Ep; chat: Ep };

  @Inject()
  dashboardService: PosDashboardService;

  @Inject()
  financeService: PosFinanceService;

  @Inject()
  alertService: PosAlertService;

  @Inject()
  reviewService: PosReviewService;

  @Inject()
  contextService: PosContextService;

  private assertToken() {
    const expected = this.healthConfig?.apiToken;
    if (!expected) throw R.forbiddenError('未配置访问令牌（HEALTH_API_TOKEN）');
    const headers: any = (this.ctx as any).headers || (this.ctx as any).header || {};
    const got = headers['x-health-token'] || (headers.authorization || '').replace('Bearer ', '');
    if (got !== expected) throw R.unauthorizedError('访问令牌无效');
  }

  private ok(data?: any) {
    return { success: true, data };
  }

  // ---------------------------------------------------------- 总览

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/ping', method: 'get', functionName: 'posPing', name: 'posPing', description: 'Personal OS 连通性 + 能力探测' })
  @NoAuth()
  async ping() {
    this.assertToken();
    const v = this.healthConfig?.vision;
    const c = this.healthConfig?.chat;
    return this.ok({
      pong: true,
      today: todayCN(),
      visionAvailable: !!(v?.apiKey && v?.model),
      chatAvailable: !!(c?.apiKey && c?.model),
    });
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/dashboard', method: 'get', functionName: 'posDashboard', name: 'posDashboard', description: '首页指标看板聚合' })
  @NoAuth()
  async dashboard() {
    this.assertToken();
    return this.ok(await this.dashboardService.dashboard());
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/alerts', method: 'get', functionName: 'posAlerts', name: 'posAlerts', description: '健康 / 热量差预警' })
  @NoAuth()
  async alerts() {
    this.assertToken();
    return this.ok(await this.alertService.current());
  }

  /** 定时函数调用（北京 08:30 / 20:30）：去重后有新预警才推送。dryRun=1 只算不推不记。 */
  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/alerts/push', method: 'post', functionName: 'posAlertsPush', name: 'posAlertsPush', description: '预警去重推送' })
  @NoAuth()
  async alertsPush(@Query(ALL) query: { dryRun?: string }) {
    this.assertToken();
    return this.ok(await this.alertService.push({ dryRun: query?.dryRun === '1' }));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/review/weekly', method: 'get', functionName: 'posReviewWeekly', name: 'posReviewWeekly', description: '健康周复盘：本周至今 + 历史周' })
  @NoAuth()
  async reviewWeekly(@Query(ALL) query: { limit?: string }) {
    this.assertToken();
    return this.ok(await this.reviewService.list(Math.min(52, Math.max(1, Number(query?.limit) || 12))));
  }

  /** 定时函数调用（每周一北京 09:00）：上一周复盘存档 + 推送（同一周只推一次）。dryRun=1 只算不存不推。 */
  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/review/weekly/run', method: 'post', functionName: 'posReviewWeeklyRun', name: 'posReviewWeeklyRun', description: '生成并推送上周复盘' })
  @NoAuth()
  async reviewWeeklyRun(@Query(ALL) query: { dryRun?: string; week?: string }) {
    this.assertToken();
    const week = query?.week && /^\d{4}-\d{2}-\d{2}$/.test(query.week) ? query.week : undefined;
    return this.ok(await this.reviewService.run({ dryRun: query?.dryRun === '1', weekStart: week }));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/career', method: 'get', functionName: 'posCareer', name: 'posCareer', description: '主业收入 + 副业经营' })
  @NoAuth()
  async career() {
    this.assertToken();
    return this.ok(await this.dashboardService.career());
  }

  // ---------------------------------------------------------- 财富

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/wealth', method: 'get', functionName: 'posWealth', name: 'posWealth', description: '资产负债汇总' })
  @NoAuth()
  async wealth() {
    this.assertToken();
    return this.ok(await this.financeService.wealth());
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/account', method: 'post', functionName: 'posAccountUpsert', name: 'posAccountUpsert', description: '新增/修改手录账户' })
  @NoAuth()
  async accountUpsert(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.financeService.upsertAccount(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/account/archive', method: 'post', functionName: 'posAccountArchive', name: 'posAccountArchive', description: '归档/恢复账户' })
  @NoAuth()
  async accountArchive(@Body(ALL) body: any) {
    this.assertToken();
    await this.financeService.archiveAccount(body?.id, body?.archived !== false);
    return this.ok();
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/balance', method: 'post', functionName: 'posBalanceUpsert', name: 'posBalanceUpsert', description: '录入/覆盖某日余额' })
  @NoAuth()
  async balanceUpsert(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.financeService.upsertBalance(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/balance/list', method: 'get', functionName: 'posBalanceList', name: 'posBalanceList', description: '账户余额历史' })
  @NoAuth()
  async balanceList(@Query(ALL) q: any) {
    this.assertToken();
    return this.ok(await this.financeService.balances(Number(q.accountId)));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/balance/delete', method: 'post', functionName: 'posBalanceDelete', name: 'posBalanceDelete', description: '删除一条余额' })
  @NoAuth()
  async balanceDelete(@Body(ALL) body: any) {
    this.assertToken();
    await this.financeService.deleteBalance(body?.id);
    return this.ok();
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/flow/list', method: 'get', functionName: 'posFlowList', name: 'posFlowList', description: '外部资金流水' })
  @NoAuth()
  async flowList(@Query(ALL) q: any) {
    this.assertToken();
    return this.ok(await this.financeService.flows(Number(q.limit) || 100));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/flow', method: 'post', functionName: 'posFlowAdd', name: 'posFlowAdd', description: '记一笔入金/出金' })
  @NoAuth()
  async flowAdd(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.financeService.addFlow(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/flow/delete', method: 'post', functionName: 'posFlowDelete', name: 'posFlowDelete', description: '删除资金流水' })
  @NoAuth()
  async flowDelete(@Body(ALL) body: any) {
    this.assertToken();
    await this.financeService.deleteFlow(body?.id);
    return this.ok();
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/income/list', method: 'get', functionName: 'posIncomeList', name: 'posIncomeList', description: '收入记录' })
  @NoAuth()
  async incomeList(@Query(ALL) q: any) {
    this.assertToken();
    return this.ok(await this.financeService.incomes(Number(q.months) || 24));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/income', method: 'post', functionName: 'posIncomeUpsert', name: 'posIncomeUpsert', description: '新增/修改收入' })
  @NoAuth()
  async incomeUpsert(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.financeService.upsertIncome(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/income/delete', method: 'post', functionName: 'posIncomeDelete', name: 'posIncomeDelete', description: '删除收入' })
  @NoAuth()
  async incomeDelete(@Body(ALL) body: any) {
    this.assertToken();
    await this.financeService.deleteIncome(body?.id);
    return this.ok();
  }

  // ---------------------------------------------------------- 随手记

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/capture', method: 'post', functionName: 'posCapture', name: 'posCapture', description: '随手记（Web / iOS 快捷指令）' })
  @NoAuth()
  async capture(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.capture(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/note/list', method: 'get', functionName: 'posNoteList', name: 'posNoteList', description: '随手记列表' })
  @NoAuth()
  async noteList(@Query(ALL) q: any) {
    this.assertToken();
    return this.ok(
      await this.contextService.notes({
        days: q.days ? Number(q.days) : undefined,
        kind: q.kind,
        domain: q.domain,
        keyword: q.keyword,
        limit: Number(q.limit) || 100,
      })
    );
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/note/update', method: 'post', functionName: 'posNoteUpdate', name: 'posNoteUpdate', description: '修改随手记' })
  @NoAuth()
  async noteUpdate(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.updateNote(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/note/delete', method: 'post', functionName: 'posNoteDelete', name: 'posNoteDelete', description: '删除随手记' })
  @NoAuth()
  async noteDelete(@Body(ALL) body: any) {
    this.assertToken();
    await this.contextService.deleteNote(body?.id);
    return this.ok();
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/note/analyze', method: 'post', functionName: 'posNoteAnalyze', name: 'posNoteAnalyze', description: 'AI 整理随手记（只产出建议）' })
  @NoAuth()
  async noteAnalyze(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.analyzeNote(Number(body?.id)));
  }

  // ---------------------------------------------------------- 事件

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/event/list', method: 'get', functionName: 'posEventList', name: 'posEventList', description: '人生事件' })
  @NoAuth()
  async eventList(@Query(ALL) q: any) {
    this.assertToken();
    return this.ok(await this.contextService.events({ status: q.status, limit: Number(q.limit) || 200 }));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/event', method: 'post', functionName: 'posEventUpsert', name: 'posEventUpsert', description: '新增/修改事件' })
  @NoAuth()
  async eventUpsert(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.upsertEvent(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/event/complete', method: 'post', functionName: 'posEventComplete', name: 'posEventComplete', description: '计划事件标记为已执行（可结转账户）' })
  @NoAuth()
  async eventComplete(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.completeEvent(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/event/delete', method: 'post', functionName: 'posEventDelete', name: 'posEventDelete', description: '删除事件' })
  @NoAuth()
  async eventDelete(@Body(ALL) body: any) {
    this.assertToken();
    await this.contextService.deleteEvent(body?.id);
    return this.ok();
  }

  // ---------------------------------------------------------- 时间线 / 指标

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/timeline', method: 'get', functionName: 'posTimeline', name: 'posTimeline', description: '统一时间线' })
  @NoAuth()
  async timeline(@Query(ALL) q: any) {
    this.assertToken();
    return this.ok(
      await this.contextService.timeline({
        days: Number(q.days) || 30,
        types: q.types,
        domain: q.domain,
      })
    );
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/metric/defs', method: 'get', functionName: 'posMetricDefs', name: 'posMetricDefs', description: '可手录指标定义' })
  @NoAuth()
  async metricDefs() {
    this.assertToken();
    return this.ok(MANUAL_METRICS);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/metric', method: 'post', functionName: 'posMetricRecord', name: 'posMetricRecord', description: '手录指标（腰围/精力/汇率…）' })
  @NoAuth()
  async metricRecord(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.recordMetric(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/metric/history', method: 'get', functionName: 'posMetricHistory', name: 'posMetricHistory', description: '手录指标历史' })
  @NoAuth()
  async metricHistory(@Query(ALL) q: any) {
    this.assertToken();
    return this.ok(await this.contextService.metricHistory(String(q.key || ''), Number(q.days) || 365));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/metric/delete', method: 'post', functionName: 'posMetricDelete', name: 'posMetricDelete', description: '删除手录指标' })
  @NoAuth()
  async metricDelete(@Body(ALL) body: any) {
    this.assertToken();
    await this.contextService.deleteMetric(body?.id);
    return this.ok();
  }

  // ---------------------------------------------------------- 关于我 / 目标

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/profile', method: 'get', functionName: 'posProfile', name: 'posProfile', description: '关于我 + 目标' })
  @NoAuth()
  async profile(@Query(ALL) q: any) {
    this.assertToken();
    const all = q.all === '1';
    const [facts, goals] = await Promise.all([
      this.contextService.facts(all),
      this.contextService.goals(all),
    ]);
    return this.ok({ facts, goals });
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/fact', method: 'post', functionName: 'posFactUpsert', name: 'posFactUpsert', description: '新增/更正「关于我」' })
  @NoAuth()
  async factUpsert(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.upsertFact(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/fact/status', method: 'post', functionName: 'posFactStatus', name: 'posFactStatus', description: '设为过期/隐藏/删除' })
  @NoAuth()
  async factStatus(@Body(ALL) body: any) {
    this.assertToken();
    await this.contextService.setFactStatus(body?.id, body?.status);
    return this.ok();
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/goal', method: 'post', functionName: 'posGoalUpsert', name: 'posGoalUpsert', description: '新增/修改目标' })
  @NoAuth()
  async goalUpsert(@Body(ALL) body: any) {
    this.assertToken();
    return this.ok(await this.contextService.upsertGoal(body));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, { path: '/pos/goal/delete', method: 'post', functionName: 'posGoalDelete', name: 'posGoalDelete', description: '删除目标' })
  @NoAuth()
  async goalDelete(@Body(ALL) body: any) {
    this.assertToken();
    await this.contextService.deleteGoal(body?.id);
    return this.ok();
  }
}
