import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { movingAverage } from './calc';

/** 行情：价格序列(带 MA)、K 线标记（计划动作/投顾信号）、标的信息与基本面。 */
@Provide()
export class InvestMarketService {
  @Inject()
  db: InvestDbService;

  /** OHLCV + MA20/MA60（服务端算，均线为全序列口径：多取 90 根再裁剪）。 */
  async price(code: string, start?: string, end?: string, limit = 250) {
    const extra = 90; // MA60 需要的暖机根数
    let rows: any[];
    if (start) {
      rows = await this.db.q(
        `SELECT trade_date, open, high, low, close, pct_chg, volume, amount
         FROM (SELECT * FROM stock_daily WHERE code = ? AND trade_date < ?
               ORDER BY trade_date DESC LIMIT ?) warm
         UNION ALL
         SELECT trade_date, open, high, low, close, pct_chg, volume, amount
         FROM stock_daily WHERE code = ? AND trade_date >= ? ${end ? 'AND trade_date <= ?' : ''}
         ORDER BY trade_date`,
        end ? [code, start, extra, code, start, end] : [code, start, extra, code, start]
      );
    } else {
      rows = (
        await this.db.q(
          `SELECT trade_date, open, high, low, close, pct_chg, volume, amount
           FROM stock_daily WHERE code = ? ${end ? 'AND trade_date <= ?' : ''}
           ORDER BY trade_date DESC LIMIT ?`,
          end ? [code, end, limit + extra] : [code, limit + extra]
        )
      ).reverse();
    }
    if (!rows.length) return { code, bars: [], ma20: [], ma60: [] };
    const closes = rows.map(r => Number(r.close));
    const ma20 = movingAverage(closes, 20);
    const ma60 = movingAverage(closes, 60);
    // 裁掉暖机段
    const from = start
      ? rows.findIndex(r => r.trade_date >= start)
      : Math.max(0, rows.length - limit);
    const cut = from < 0 ? 0 : from;
    return {
      code,
      bars: rows.slice(cut),
      ma20: ma20.slice(cut).map(v => (v == null ? null : Math.round(v * 1000) / 1000)),
      ma60: ma60.slice(cut).map(v => (v == null ? null : Math.round(v * 1000) / 1000)),
    };
  }

  /** K 线标记：该标的历史计划动作 + 投顾信号日期。 */
  async marks(code: string) {
    const plans = await this.db.q(
      `SELECT plan_date, action, ref_price, stop_price, reason, trigger_hint
       FROM action_plan WHERE code = ? ORDER BY plan_date`,
      [code]
    );
    const recos = await this.db.q(
      `SELECT rec_date, source_type, grade, direction, catalyst
       FROM advisor_reco WHERE code = ? ORDER BY rec_date`,
      [code]
    );
    return { plans, recos };
  }

  /** 资金与因子维度：北向持股 / 融资余额 / 最新因子暴露。 */
  async extras(code: string, days = 120) {
    const [hkHold, margin, factorDate] = await Promise.all([
      this.db.q(
        `SELECT trade_date, vol, ratio FROM stock_hk_hold
         WHERE code = ? ORDER BY trade_date DESC LIMIT ?`,
        [code, days]
      ).catch(() => []),
      this.db.q(
        `SELECT trade_date, rzye FROM stock_margin
         WHERE code = ? ORDER BY trade_date DESC LIMIT ?`,
        [code, days]
      ).catch(() => []),
      this.db
        .one('SELECT MAX(trade_date) d FROM factor_exposure WHERE code = ?', [code])
        .catch(() => null),
    ]);
    const factors = factorDate?.d
      ? await this.db.q(
          `SELECT factor, value FROM factor_exposure
           WHERE code = ? AND trade_date = ? ORDER BY factor`,
          [code, factorDate.d]
        )
      : [];
    return {
      hkHold: hkHold.reverse(),
      margin: margin.reverse(),
      factors,
      factorDate: factorDate?.d ?? null,
    };
  }

  /** 标的信息 + 最新估值/财务；q 为名称/代码模糊搜索。 */
  async stockInfo(code?: string, q?: string) {
    if (q) {
      const like = `%${q}%`;
      const list = await this.db.q(
        `SELECT ts_code, symbol, name, industry, market FROM stock_info
         WHERE ts_code LIKE ? OR symbol LIKE ? OR name LIKE ? LIMIT 10`,
        [like, like, like]
      );
      return { list };
    }
    if (!code) return { info: null };
    const info = await this.db.one(
      'SELECT ts_code, symbol, name, area, industry, market, list_date FROM stock_info WHERE ts_code = ?',
      [code]
    );
    const fundamental = await this.db.one(
      `SELECT trade_date, pe_ttm, pb, ps_ttm, total_mv, circ_mv, turnover_rate
       FROM stock_fundamental WHERE code = ? ORDER BY trade_date DESC LIMIT 1`,
      [code]
    );
    const fina = await this.db
      .one(
        `SELECT report_date, ann_date, eps, bps, roe, roa, gross_margin, debt_to_asset,
                revenue_yoy, profit_yoy, revenue, net_profit, ocfps
         FROM stock_fina_indicator WHERE code = ? ORDER BY report_date DESC LIMIT 1`,
        [code]
      )
      .catch(() => null);
    return { info, fundamental, fina };
  }
}
