import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';

const parseJson = (s: any) => {
  if (s == null || typeof s === 'object') return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * 套利模块只读数据层：统一资金账本 sleeve / carry 信号 / 盲区α / 三水表资金流 /
 * 战绩记分卡。数据由 Python invest-model 写入 invest 库，本服务仅 SELECT。
 * 观察态（ARB_ENABLED=0）下这些表可能为空——前端 EmptyState 兜底。
 */
@Provide()
export class InvestArbitrageService {
  @Inject()
  db: InvestDbService;

  /** 统一资金账本：最近一期 sleeve 分配 + 账户层套利元数据。 */
  async ledger(date?: string) {
    const d = date
      ? { plan_date: date }
      : await this.db.one(
          'SELECT MAX(plan_date) plan_date FROM sleeve_target'
        );
    const planDate = d?.plan_date;
    if (!planDate) return { plan_date: null, sleeves: [], account: null };
    // 优先展示实盘账本行（note='live'），否则回退回测行（'backtest'）。
    const rows = await this.db.q(
      `SELECT sleeve, target_pct, actual_pct, min_pct, max_pct, nav, note
       FROM sleeve_target WHERE plan_date = ? ORDER BY
       CASE note WHEN 'live' THEN 0 WHEN 'backtest' THEN 1 ELSE 2 END`,
      [planDate]
    );
    const seen = new Set<string>();
    const sleeves = rows.filter(r => {
      if (seen.has(r.sleeve)) return false;
      seen.add(r.sleeve);
      return true;
    });
    const account = await this.db.one(
      `SELECT plan_date, equity, gross_target, defense_pct, offense_pct, alpha_pct,
              sleeve_gross, ledger_ok, carry_expected, fear_score, risk_hints
       FROM action_plan_account WHERE plan_date = ?`,
      [planDate]
    );
    return { plan_date: planDate, sleeves, account };
  }

  /** carry 信号（逆回购/红利/可转债），可按 sleeve 过滤。 */
  async carry(f: { date?: string; sleeve?: string }) {
    const d = f.date
      ? f.date
      : (await this.db.one('SELECT MAX(trade_date) t FROM carry_signal'))?.t;
    if (!d) return { trade_date: null, list: [] };
    const where = ['trade_date = ?'];
    const params: any[] = [d];
    if (f.sleeve) {
      where.push('sleeve = ?');
      params.push(f.sleeve);
    }
    const list = await this.db.q(
      `SELECT trade_date, sleeve, code, version, expected_carry, horizon_days, rank, metric
       FROM carry_signal WHERE ${where.join(' AND ')} ORDER BY sleeve, rank LIMIT 200`,
      params
    );
    return { trade_date: d, list: list.map(r => ({ ...r, metric: parseJson(r.metric) })) };
  }

  /** 盲区 α 候选（当期有效，带证伪状态）。 */
  async alpha(date?: string) {
    const d = date
      ? date
      : (await this.db.one('SELECT MAX(as_of_date) t FROM alpha_candidate'))?.t;
    if (!d) return { as_of_date: null, list: [] };
    const list = await this.db.q(
      `SELECT as_of_date, code, theme, thesis, falsification_rule, falsified,
              water_meter, grade, valid_until, evidence
       FROM alpha_candidate WHERE as_of_date <= ?
       AND (valid_until IS NULL OR valid_until = '' OR valid_until >= ?)
       ORDER BY as_of_date DESC LIMIT 200`,
      [d, d]
    );
    return { as_of_date: d, list };
  }

  /** 三水表资金流分（最近一期，按 composite 降序）。 */
  async flow(date?: string) {
    const d = date
      ? date
      : (await this.db.one('SELECT MAX(trade_date) t FROM flow_score'))?.t;
    if (!d) return { trade_date: null, list: [] };
    const list = await this.db.q(
      `SELECT trade_date, dimension, key, credit, fiscal, policy, composite, z
       FROM flow_score WHERE trade_date = ? ORDER BY composite DESC LIMIT 200`,
      [d]
    );
    return { trade_date: d, list };
  }

  /** 套利战绩记分卡（最近一次统计）。 */
  async scorecard() {
    const d = (await this.db.one('SELECT MAX(as_of) t FROM arb_scorecard'))?.t;
    if (!d) return { as_of: null, list: [] };
    const list = await this.db.q(
      `SELECT as_of, bucket, label, n, win_rate, mean_ret, median_ret,
              mean_excess, mean_hold_days
       FROM arb_scorecard WHERE as_of = ? ORDER BY bucket`,
      [d]
    );
    return { as_of: d, list };
  }
}
