import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';

/**
 * Skill 第二批数据（2026-11-05 owner「库里数据比较多，Skill 透出的能力只有那几个，用户玩不起来」）。
 *
 * 都是市场级、只读、已在库里每日更新的数据，原样给读数，不给任何买卖主张：
 *  - 涨跌停情绪（market_sentiment_daily）+ 昨日涨停今日表现（money_effect_daily）；
 *  - 同花顺行业/概念/地域指数涨跌排行与单个板块走势（ths_index_daily + ths_index_catalog）；
 *  - 主要指数日线（index_daily，只开每日在更新的那几只）；
 *  - 宽基规则历史回测成绩（web_dataset.broadIndex 的汇总段，网站首页同一份数据）。
 * 个股数据不开（11-03 owner 关闭个股功能）。
 */

type Db = Pick<InvestDbService, 'q' | 'one'>;

/** 对外开放的指数（index_daily 里每日更新的那几只；停更的不开，免得给出旧数）。 */
export const OPEN_INDEXES: Record<string, string> = {
  '000001.SH': '上证指数',
  '000016.SH': '上证50',
  '000300.SH': '沪深300',
  '000905.SH': '中证500',
  '000852.SH': '中证1000',
  '000906.SH': '中证800',
  '000922.CSI': '中证红利',
  '399006.SZ': '创业板指',
  '000688.SH': '科创50',
};

export const SECTOR_TAGS: Record<string, string> = {
  industry: '行业',
  concept: '概念',
  region: '地域',
};
const TAG_DB: Record<string, string> = {
  industry: 'industry',
  concept: 'cn_concept',
  region: 'region',
};

const num = (v: any) =>
  v === null || v === undefined || v === '' ? null : Number(v);
const pct = (v: number | null, d = 2) =>
  v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** (d + 2)) / 10 ** d;
const clampInt = (v: any, lo: number, hi: number, dflt: number) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
};

const CACHE = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, fn: () => Promise<T>, ms = 10 * 60 * 1000): Promise<T> {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v as T;
  const v = await fn();
  CACHE.set(key, { at: Date.now(), v });
  return v;
}
export function clearMarketDataCache() {
  CACHE.clear();
}

/** 截至 date（含）往前第 n 个交易日（n=0 即 date 本身所在的最近交易日）。 */
async function tradeDaysBack(db: Db, date: string, n: number): Promise<string[]> {
  const rows = await db.q(
    'SELECT cal_date FROM trade_calendar WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT ?',
    [date, n + 1]
  );
  return rows.map((r: any) => String(r.cal_date));
}

export async function marketSentiment(db: Db, days = 20) {
  const n = clampInt(days, 1, 250, 20);
  const rows = await db.q(
    'SELECT trade_date, limit_up_cnt, limit_down_cnt, limit_break_cnt, max_board, board2_cnt, board3p_cnt ' +
      'FROM market_sentiment_daily ORDER BY trade_date DESC LIMIT ?',
    [n]
  );
  const eff = rows.length
    ? await db.q(
        'SELECT trade_date, yest_pool_n, yest_pool_ret, yest_pool_open_ret FROM money_effect_daily ' +
          'WHERE trade_date >= ? ORDER BY trade_date',
        [String(rows[rows.length - 1].trade_date)]
      )
    : [];
  const effBy = new Map(eff.map((e: any) => [String(e.trade_date), e]));
  const out = rows.reverse().map((r: any) => {
    const up = num(r.limit_up_cnt);
    const brk = num(r.limit_break_cnt);
    const e: any = effBy.get(String(r.trade_date));
    return {
      trade_date: String(r.trade_date),
      limit_up: up,
      limit_down: num(r.limit_down_cnt),
      limit_break: brk,
      // 封板率＝涨停 /（涨停+炸板）
      seal_rate_pct: up !== null && brk !== null && up + brk > 0 ? pct(up / (up + brk), 1) : null,
      max_board: num(r.max_board),
      board2: num(r.board2_cnt),
      board3_plus: num(r.board3p_cnt),
      yesterday_limit_up_today: e
        ? {
            count: num(e.yest_pool_n),
            avg_change_pct: pct(num(e.yest_pool_ret)),
            avg_open_premium_pct: pct(num(e.yest_pool_open_ret)),
          }
        : null,
    };
  });
  return { days: out.length, rows: out };
}

export async function sectorRank(
  db: Db,
  opt: { tag?: string; period?: number; top?: number; order?: string }
) {
  const tag = TAG_DB[String(opt.tag || 'industry')] ? String(opt.tag || 'industry') : 'industry';
  const period = clampInt(opt.period, 1, 250, 5);
  const top = clampInt(opt.top, 1, 50, 10);
  const asc = String(opt.order || 'top') === 'bottom';
  const all = await cached(`rank:${tag}:${period}`, async () => {
    const last = await db.one('SELECT MAX(trade_date) d FROM ths_index_daily');
    const latest = last?.d ? String(last.d) : null;
    if (!latest) return { latest: null, base: null, items: [] as any[] };
    const cal = await tradeDaysBack(db, latest, period);
    const base = cal.length > period ? cal[period] : null;
    if (!base) return { latest, base: null, items: [] as any[] };
    const rows = await db.q(
      'SELECT d.thscode, c.name, d.trade_date, d.close, d.turnover FROM ths_index_daily d ' +
        'JOIN ths_index_catalog c ON c.thscode = d.thscode ' +
        'WHERE c.tag = ? AND d.trade_date IN (?, ?)',
      [TAG_DB[tag], latest, base]
    );
    const by = new Map<string, any>();
    for (const r of rows) {
      const k = String(r.thscode);
      const o = by.get(k) || { code: k, name: r.name };
      if (String(r.trade_date) === latest) {
        o.close = num(r.close);
        o.turnover = num(r.turnover);
      } else o.base = num(r.close);
      by.set(k, o);
    }
    const items = [...by.values()]
      .filter(o => o.close && o.base)
      .map(o => ({
        code: o.code,
        name: o.name,
        close: o.close,
        change_pct: pct(o.close / o.base - 1),
        turnover_yi: o.turnover === null || o.turnover === undefined ? null : Math.round(o.turnover / 1e6) / 100,
      }));
    return { latest, base, items };
  });
  const items = [...all.items].sort((a, b) =>
    asc ? a.change_pct - b.change_pct : b.change_pct - a.change_pct
  );
  return {
    category: SECTOR_TAGS[tag],
    period_days: period,
    from_date: all.base,
    to_date: all.latest,
    total: items.length,
    order: asc ? 'bottom' : 'top',
    items: items.slice(0, top),
  };
}

export async function sectorHistory(
  db: Db,
  opt: { keyword?: string; code?: string; days?: number }
) {
  const days = clampInt(opt.days, 5, 750, 120);
  let hits: any[] = [];
  if (opt.code) {
    hits = await db.q('SELECT thscode, name, tag FROM ths_index_catalog WHERE thscode = ?', [
      String(opt.code).toUpperCase().slice(0, 16),
    ]);
  } else if (opt.keyword) {
    const kw = String(opt.keyword).replace(/[%_\\]/g, '').trim().slice(0, 20);
    if (!kw) return { matches: [], rows: [] };
    hits = await db.q(
      "SELECT thscode, name, tag FROM ths_index_catalog WHERE name LIKE ? AND tag IN ('industry','cn_concept','region') ORDER BY CHAR_LENGTH(name) LIMIT 10",
      [`%${kw}%`]
    );
  }
  const tagName = (t: string) =>
    SECTOR_TAGS[Object.keys(TAG_DB).find(k => TAG_DB[k] === t) || ''] || t;
  const matches = hits.map((h: any) => ({ code: String(h.thscode), name: h.name, category: tagName(h.tag) }));
  if (!matches.length) return { matches, rows: [] };
  const pick = matches[0];
  const rows = await db.q(
    'SELECT trade_date, open, high, low, close, turnover FROM ths_index_daily WHERE thscode = ? ORDER BY trade_date DESC LIMIT ?',
    [pick.code, days]
  );
  return {
    sector: pick,
    other_matches: matches.slice(1),
    rows: rows.reverse().map((r: any) => ({
      trade_date: String(r.trade_date),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      turnover_yi: r.turnover === null || r.turnover === undefined ? null : Math.round(Number(r.turnover) / 1e6) / 100,
    })),
  };
}

export async function indexHistory(db: Db, opt: { code?: string; start?: string; end?: string }) {
  const code = String(opt.code || '000300.SH').toUpperCase();
  if (!OPEN_INDEXES[code]) return { error: 'unknown_code', open_indexes: OPEN_INDEXES };
  const end = opt.end || '99991231';
  let start = opt.start;
  if (!start) {
    const t = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    start = t.toISOString().slice(0, 10).replace(/-/g, '');
  }
  const rows = await db.q(
    'SELECT trade_date, open, high, low, close, pct_chg, amount FROM index_daily ' +
      'WHERE code = ? AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date LIMIT 3000',
    [code, start, end]
  );
  return {
    code,
    name: OPEN_INDEXES[code],
    start,
    end: opt.end || null,
    rows: rows.map((r: any) => ({
      trade_date: String(r.trade_date),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      change_pct: num(r.pct_chg),
      // tushare 指数日线 amount 单位千元 → 亿元
      amount_yi: r.amount === null || r.amount === undefined ? null : Math.round(Number(r.amount) / 1e3) / 100,
    })),
  };
}

const LEG_INDEX: Record<string, string> = {
  沪深300: '沪深300',
  红利: '中证红利',
  创业板: '创业板指',
  科创50: '科创50',
};
const LEG_ORDER = ['沪深300', '红利', '创业板', '科创50'];

/** 宽基规则历史回测成绩：每个指数的年化/累计/最大回撤/买卖次数 + 逐年对照买入持有。 */
export function backtestSummary(payload: any) {
  const legs: any[] = Array.isArray(payload?.legs) ? payload.legs : [];
  const r4 = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v) * 10000) / 100);
  return legs
    .slice()
    .sort((a, b) => LEG_ORDER.indexOf(a.name) - LEG_ORDER.indexOf(b.name))
    .map(l => {
      const years = new Map<string, { r: number; bh: number }>();
      for (const m of Array.isArray(l.monthly) ? l.monthly : []) {
        const y = String(m.ym).slice(0, 4);
        const o = years.get(y) || { r: 1, bh: 1 };
        o.r *= 1 + Number(m.r || 0);
        o.bh *= 1 + Number(m.bh || 0);
        years.set(y, o);
      }
      return {
        index: LEG_INDEX[l.name] || l.name,
        from: l.start ? String(l.start) : null,
        to: l.end ? String(l.end) : null,
        years: l.years ?? null,
        rule_annual_return_pct: r4(l.ann),
        buy_hold_annual_return_pct: r4(l.bh_ann),
        rule_total_multiple: l.cum ?? null,
        buy_hold_total_multiple: l.bh_cum ?? null,
        rule_max_drawdown_pct: r4(l.mdd),
        buy_hold_max_drawdown_pct: r4(l.bh_mdd),
        average_position_pct: r4(l.pos_avg),
        buys: l.n_buy ?? null,
        sells: l.n_sell ?? null,
        yearly: [...years.entries()].map(([year, o]) => ({
          year,
          rule_return_pct: Math.round((o.r - 1) * 10000) / 100,
          buy_hold_return_pct: Math.round((o.bh - 1) * 10000) / 100,
        })),
      };
    });
}

export const BACKTEST_CAVEATS = [
  '这是历史回测，不是收益承诺；历史上有效的规则未来可能失效。',
  '红利与科创50 对应的 ETF 上市较晚，回测前段这两个指数的买卖在当时无法真实执行。',
  '统计上不显著：近二十年真正独立的大周期只有三四个，超额收益可能有运气成分。',
  '这套规则更适合当纪律用（高位管住手、大跌敢买），不适合拿来预测收益。',
  '红利按含分红的全收益指数计算，在红利上这套规则跑输买入持有。',
];

@Provide()
export class InvestMarketDataService {
  @Inject()
  db: InvestDbService;

  sentiment(days?: number) {
    return cached(`sent:${days}`, () => marketSentiment(this.db, days));
  }
  sectorRank(opt: { tag?: string; period?: number; top?: number; order?: string }) {
    return sectorRank(this.db, opt);
  }
  sectorHistory(opt: { keyword?: string; code?: string; days?: number }) {
    return sectorHistory(this.db, opt);
  }
  indexHistory(opt: { code?: string; start?: string; end?: string }) {
    return indexHistory(this.db, opt);
  }
  backtest() {
    return cached('backtest', async () => {
      const row = await this.db.one("SELECT payload FROM web_dataset WHERE name = 'broadIndex'");
      if (!row?.payload) return { legs: [] as any[] };
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      return { generated_at: payload.generated_at || null, legs: backtestSummary(payload) };
    });
  }
}
