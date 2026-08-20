import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { movingAverage } from './calc';

// 实时行情缓存（模块级，跨请求共享；10s TTL 防止高频转发到上游）
const quoteCache = new Map<string, { at: number; data: any }>();

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

  /**
   * 实时行情（盘中现价/涨跌幅）：腾讯免费源 qt.gtimg.cn（与 invest-model 盯盘服务同源）。
   * 非交易时段返回最后成交价；停牌/无数据的代码自动缺席。10s 缓存。
   * 返回 { quotes: { '600000.SH': {price, pre_close, chg, chg_pct, time} }, fetched_at }。
   */
  async quotes(codes: string[]) {
    const valid = [...new Set(codes)].filter(c => /^\d{6}\.(SH|SZ|BJ)$/.test(c)).slice(0, 50);
    if (!valid.length) return { quotes: {}, fetched_at: new Date().toISOString() };
    const key = valid.slice().sort().join(',');
    const hit = quoteCache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit.data;

    const syms = valid.map(c => {
      const [num, ex] = c.split('.');
      return (ex === 'SH' ? 'sh' : ex === 'SZ' ? 'sz' : 'bj') + num;
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    let text = '';
    try {
      const resp = await fetch(`https://qt.gtimg.cn/q=${syms.join(',')}`, {
        signal: ac.signal,
      });
      // 响应为 GBK；只取数字字段，中文名称字段忽略，用 latin1 解码不影响数字解析
      text = Buffer.from(await resp.arrayBuffer()).toString('latin1');
    } finally {
      clearTimeout(timer);
    }
    const quotes: Record<string, any> = {};
    for (const m of text.matchAll(/v_(sh|sz|bj)(\d{6})="([^"]*)"/g)) {
      const f = m[3].split('~');
      if (f.length < 33) continue;
      const price = parseFloat(f[3]);
      if (!price || !Number.isFinite(price)) continue; // 停牌/无价
      quotes[`${m[2]}.${m[1].toUpperCase()}`] = {
        price,
        pre_close: parseFloat(f[4]) || null,
        chg: parseFloat(f[31]) || 0,
        chg_pct: parseFloat(f[32]) || 0, // 百分数，如 1.23 表示 +1.23%
        time: f[30] || null, // 形如 20260703150003
      };
    }
    const data = { quotes, fetched_at: new Date().toISOString() };
    quoteCache.set(key, { at: Date.now(), data });
    if (quoteCache.size > 100) quoteCache.clear(); // 粗暴防膨胀
    return data;
  }

  /** 资金与因子维度：北向持股 / 融资余额 / 最新因子暴露。 */
  async extras(code: string, days = 120) {
    const [hkHold, margin, factorDate] = await Promise.all([
      this.db.q(
        `SELECT trade_date, vol, ratio FROM stock_hk_hold
         WHERE code = ? ORDER BY trade_date DESC LIMIT ?`,
        [code, days]
      ).catch(() => []),
      // P1-3（2026-08-20 审计）：日更管道写的是 stock_margin_detail，
      // 旧表 stock_margin 无生产写入方——此前读错表致融资余额长期空值。
      this.db.q(
        `SELECT trade_date, rzye FROM stock_margin_detail
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
