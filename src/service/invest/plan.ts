import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';

/** 每日操作计划：三段式分组（复刻 action_plan.py render_markdown 的分段口径）。 */
@Provide()
export class InvestPlanService {
  @Inject()
  db: InvestDbService;

  async dates(): Promise<string[]> {
    const rows = await this.db.q(
      'SELECT DISTINCT plan_date FROM action_plan ORDER BY plan_date DESC LIMIT 120'
    );
    return rows.map(r => r.plan_date);
  }

  async plan(date?: string) {
    const d =
      date ||
      (await this.db.one('SELECT MAX(plan_date) d FROM action_plan'))?.d;
    if (!d) return { date: null, account: null, buys: [], holdings: [], watch: [] };
    const rows = await this.db.q(
      `SELECT plan_date, code, name, action, cur_weight, tgt_weight, shares_delta,
              reason, stop_price, ref_price, grade, trigger_hint, model_rank, model_view
       FROM action_plan WHERE plan_date = ? ORDER BY tgt_weight DESC, code`,
      [d]
    );
    const account = await this.db.one(
      'SELECT * FROM action_plan_account WHERE plan_date = ?',
      [d]
    );
    // 三段式：一、建议买入(buy/add) 二、当前持仓·风控动作(hold/trim/sell) 三、观察池(watch)
    const buys = rows.filter(r => r.action === 'buy' || r.action === 'add');
    const watch = rows.filter(r => r.action === 'watch');
    const order = { sell: 0, trim: 1, hold: 2 };
    const holdings = rows
      .filter(r => !['buy', 'add', 'watch'].includes(r.action))
      .sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9));
    return { date: d, account, buys, holdings, watch };
  }
}
