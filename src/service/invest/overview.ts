import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { InvestInsightService } from './insight';

/** 总览聚合：账户/净值/最新计划账户块/恐慌/模型健康/今日预警，一次请求出全屏。 */
@Provide()
export class InvestOverviewService {
  @Inject()
  db: InvestDbService;

  @Inject()
  insight: InvestInsightService;

  async overview() {
    const [account, equitySeries, planAccount, latestPlan, fear, registryRows, bt, alertAgg, holdingsCnt] =
      await Promise.all([
        this.db.one(
          'SELECT snapshot_date, cash, market_value, total_asset FROM account_snapshot ORDER BY snapshot_date DESC LIMIT 1'),
        this.db.q(
          'SELECT snapshot_date, cash, market_value, total_asset FROM account_snapshot ORDER BY snapshot_date'),
        this.db.one('SELECT * FROM action_plan_account ORDER BY plan_date DESC LIMIT 1'),
        this.db.one(
          `SELECT plan_date,
                  SUM(action IN ('buy','add')) buys,
                  SUM(action IN ('sell','trim')) risks,
                  SUM(action = 'watch') watches,
                  SUM(action = 'hold') holds
           FROM action_plan
           WHERE plan_date = (SELECT MAX(plan_date) FROM action_plan)
           GROUP BY plan_date`),
        this.insight.fearLatest(),
        this.db.q(
          'SELECT version, cv_ic_mean, cv_ic_ir, cv_hit_rate, created_at FROM model_registry ORDER BY created_at DESC LIMIT 1'),
        // P77：不再取「任意最新」——纯量化 run 优先（与模型详情接口同序），
        // 带策略身份下发；防止投顾主导页面被无关 run 的数字背书
        this.db.one(
          `SELECT metrics, strategy_id, decision_mode FROM backtest_run
           ORDER BY (decision_mode = 'cs_quant') DESC, (strategy LIKE 'cs%') DESC,
                    created_at DESC LIMIT 1`),
        this.db.one(
          `SELECT alert_date, COUNT(*) n FROM watch_alert
           WHERE alert_date = (SELECT MAX(alert_date) FROM watch_alert)
           GROUP BY alert_date`),
        this.db.one('SELECT COUNT(*) n FROM current_holding'),
      ]);
    let backtestMetrics = null;
    try {
      backtestMetrics = bt?.metrics ? JSON.parse(bt.metrics) : null;
    } catch {
      backtestMetrics = null;
    }
    return {
      account,
      equitySeries,
      planAccount,
      planSummary: latestPlan
        ? {
            plan_date: latestPlan.plan_date,
            buys: Number(latestPlan.buys) || 0,
            risks: Number(latestPlan.risks) || 0,
            watches: Number(latestPlan.watches) || 0,
            holds: Number(latestPlan.holds) || 0,
          }
        : null,
      fear,
      model: {
        registry: registryRows[0] || null,
        backtestMetrics,
        // P77：数字可反查唯一策略身份（老 run 为 null=身份未知）
        backtestStrategyId: bt?.strategy_id ?? null,
        backtestDecisionMode: bt?.decision_mode ?? null,
      },
      alerts: alertAgg ? { date: alertAgg.alert_date, count: Number(alertAgg.n) } : null,
      holdingCount: Number(holdingsCnt?.n) || 0,
    };
  }
}
