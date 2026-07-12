import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';

/**
 * 美股模块只读聚合（us_* 表由 invest-model us-update workflow 写入）。
 * 与 A 股服务零交集：独立文件、独立表前缀，互不 import。
 */
@Provide()
export class InvestUsService {
  @Inject()
  db: InvestDbService;

  async overview() {
    const [account, equitySeries, planAccount, planSummary, optionCount, holdings] =
      await Promise.all([
        this.db.one(
          'SELECT snapshot_date, cash, market_value, total_asset FROM us_account_snapshot ORDER BY snapshot_date DESC LIMIT 1'),
        this.db.q(
          'SELECT snapshot_date, cash, market_value, total_asset FROM us_account_snapshot ORDER BY snapshot_date'),
        this.db.one('SELECT * FROM us_plan_account ORDER BY plan_date DESC LIMIT 1'),
        this.db.one(
          `SELECT plan_date,
                  SUM(action = 'buy') buys,
                  SUM(action IN ('trim','sell')) risks,
                  SUM(action = 'hold') holds,
                  SUM(action = 'watch') watches,
                  SUM(action IN ('csp','cc')) income_moves
           FROM us_action_plan
           WHERE plan_date = (SELECT MAX(plan_date) FROM us_action_plan)
           GROUP BY plan_date`),
        this.db.one(
          `SELECT COUNT(*) n FROM us_option_candidate
           WHERE plan_date = (SELECT MAX(plan_date) FROM us_option_candidate)`),
        this.db.one('SELECT COUNT(*) n FROM us_current_holding'),
      ]);
    return {
      account,
      equitySeries,
      planAccount,
      planSummary,
      optionCandidates: Number(optionCount?.n || 0),
      holdingCount: Number(holdings?.n || 0),
    };
  }

  async planDates() {
    const rows = await this.db.q(
      'SELECT DISTINCT plan_date FROM us_action_plan ORDER BY plan_date DESC LIMIT 60');
    return rows.map((r: any) => r.plan_date);
  }

  async plan(date?: string) {
    const d =
      date ||
      (await this.db.one('SELECT MAX(plan_date) d FROM us_action_plan'))?.d;
    if (!d) return { plan_date: null, account: null, rows: [], options: [] };
    const [account, rows, options] = await Promise.all([
      this.db.one('SELECT * FROM us_plan_account WHERE plan_date = ?', [d]),
      this.db.q(
        `SELECT * FROM us_action_plan WHERE plan_date = ?
         ORDER BY FIELD(sleeve,'core','income','satellite','cash'),
                  FIELD(grade,'A','B','-','C'), code`, [d]),
      this.db.q(
        `SELECT * FROM us_option_candidate WHERE plan_date = ?
         ORDER BY strategy, safety_margin DESC, annualized_yield DESC`, [d]),
    ]);
    return { plan_date: d, account, rows, options };
  }

  async holdings() {
    return this.db.q(
      `SELECT h.code, h.shares, h.cost_price, h.sleeve, h.entry_date,
              i.name, i.sector,
              (SELECT close FROM us_stock_daily d
               WHERE d.code = h.code ORDER BY trade_date DESC LIMIT 1) last_close
       FROM us_current_holding h
       LEFT JOIN us_stock_info i ON i.code = h.code
       ORDER BY h.sleeve, h.code`);
  }

  async upsertHolding(body: {
    code: string; shares: number; cost_price: number; sleeve?: string; entry_date?: string;
  }) {
    await this.db.exec(
      `INSERT INTO us_current_holding (code, shares, cost_price, sleeve, entry_date)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE shares = VALUES(shares), cost_price = VALUES(cost_price),
         sleeve = VALUES(sleeve), entry_date = VALUES(entry_date)`,
      [body.code.toUpperCase(), body.shares, body.cost_price,
       body.sleeve || 'satellite', body.entry_date || null]);
    return { ok: true };
  }

  async deleteHolding(code: string) {
    await this.db.exec('DELETE FROM us_current_holding WHERE code = ?', [code.toUpperCase()]);
    return { ok: true };
  }

  async watchlist() {
    return this.db.q(
      `SELECT i.code, i.name, i.kind, i.sector, i.sleeve_hint,
              (SELECT close FROM us_stock_daily d
               WHERE d.code = i.code ORDER BY trade_date DESC LIMIT 1) last_close,
              (SELECT grade FROM us_action_plan p
               WHERE p.code = i.code AND p.sleeve = 'satellite'
               ORDER BY plan_date DESC LIMIT 1) grade,
              (SELECT reason FROM us_action_plan p
               WHERE p.code = i.code AND p.sleeve = 'satellite'
               ORDER BY plan_date DESC LIMIT 1) reason
       FROM us_stock_info i
       WHERE i.code != '^VIX'
       ORDER BY FIELD(i.kind,'etf','stock'), i.code`);
  }
}
