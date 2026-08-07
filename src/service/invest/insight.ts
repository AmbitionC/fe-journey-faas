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

/** 复盘报告、盯盘预警、模型健康（注册表/因子IC/回测）、恐慌指数。 */
@Provide()
export class InvestInsightService {
  @Inject()
  db: InvestDbService;

  async reviewList(period?: string) {
    const w = period ? 'WHERE period = ?' : '';
    return this.db.q(
      `SELECT report_date, period, version, created_at FROM review_report ${w}
       ORDER BY report_date DESC, period`,
      period ? [period] : []
    );
  }

  async review(date: string, period: string) {
    return this.db.one(
      'SELECT report_date, period, version, markdown, meta, created_at FROM review_report WHERE report_date = ? AND period = ?',
      [date, period]
    );
  }

  async alerts(f: { date?: string; kind?: string; severity?: string; page?: number; pageSize?: number }) {
    const where: string[] = [];
    const params: any[] = [];
    if (f.date) { where.push('alert_date = ?'); params.push(f.date); }
    if (f.kind) { where.push('kind = ?'); params.push(f.kind); }
    if (f.severity) { where.push('severity = ?'); params.push(f.severity); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, f.page || 1);
    const pageSize = Math.min(200, f.pageSize || 50);
    const [cnt] = await this.db.q(`SELECT COUNT(*) n FROM watch_alert ${w}`, params);
    const list = await this.db.q(
      `SELECT id, alert_date, alert_time, code, kind, severity, message
       FROM watch_alert ${w} ORDER BY alert_time DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const dates = await this.db.q(
      'SELECT DISTINCT alert_date FROM watch_alert ORDER BY alert_date DESC LIMIT 30');
    return { list, total: Number(cnt.n), dates: dates.map(r => r.alert_date) };
  }

  async registry() {
    return this.db.q(
      `SELECT version, model_type, train_start, train_end, n_samples, n_factors,
              factor_cols, cv_ic_mean, cv_ic_ir, cv_hit_rate, created_at
       FROM model_registry ORDER BY created_at DESC LIMIT 20`
    );
  }

  async ic(f: { factor?: string; horizon?: number; start?: string; end?: string }) {
    const where: string[] = [];
    const params: any[] = [];
    if (f.factor) { where.push('factor_name = ?'); params.push(f.factor); }
    if (f.horizon) { where.push('horizon = ?'); params.push(f.horizon); }
    if (f.start) { where.push('trade_date >= ?'); params.push(f.start); }
    if (f.end) { where.push('trade_date <= ?'); params.push(f.end); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.db.q(
      `SELECT trade_date, factor_name, horizon, ic, rank_ic FROM factor_ic_log ${w}
       ORDER BY trade_date`,
      params
    );
    // 按因子聚合：序列 + 均值（热力图/条形图数据源）
    const byFactor: Record<string, { series: any[]; mean_ic: number; mean_rank_ic: number }> = {};
    for (const r of rows) {
      (byFactor[r.factor_name] ||= { series: [], mean_ic: 0, mean_rank_ic: 0 }).series.push(r);
    }
    for (const k of Object.keys(byFactor)) {
      const s = byFactor[k].series;
      byFactor[k].mean_ic = s.reduce((a, b) => a + (Number(b.ic) || 0), 0) / s.length;
      byFactor[k].mean_rank_ic = s.reduce((a, b) => a + (Number(b.rank_ic) || 0), 0) / s.length;
    }
    return { byFactor };
  }

  async backtest(runId?: number) {
    // 「量化引擎·历史自检」要的是 CS 因子模型自检回测（name 形如 cs_<version>）。
    // 套利账本/各 sleeve 回测（arb_repo / arb_ledger / arb_offense…）也按 version 落
    // 同一张 backtest_run（下游零改动的设计），若直接取 created_at 最新，会被这些
    // 未持仓的 arb run（top_k=0、nav 恒为 1）盖住，导致组合净值看起来一直是平的。
    // 故未指定 runId 时，优先取最新的 cs_ 模型 run；兜底再退回最新任意 run。
    const run = runId
      ? await this.db.one('SELECT * FROM backtest_run WHERE run_id = ?', [runId])
      : (await this.db.one(
          "SELECT * FROM backtest_run WHERE name LIKE 'cs%' ORDER BY created_at DESC LIMIT 1"
        )) ?? (await this.db.one('SELECT * FROM backtest_run ORDER BY created_at DESC LIMIT 1'));
    if (!run) return { run: null, nav: [], benchmark: [] };
    run.metrics = parseJson(run.metrics);
    run.params = parseJson(run.params);
    const nav = await this.db.q(
      `SELECT trade_date, nav, ret, turnover, position_count FROM backtest_nav
       WHERE run_id = ? ORDER BY trade_date`,
      [run.run_id]
    );
    let benchmark: any[] = [];
    if (nav.length) {
      const bench = await this.db.q(
        `SELECT trade_date, close FROM index_daily
         WHERE code = '000300.SH' AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date`,
        [nav[0].trade_date, nav[nav.length - 1].trade_date]
      );
      if (bench.length) {
        const base = Number(bench[0].close);
        const nav0 = Number(nav[0].nav) || 1;
        benchmark = bench.map(b => ({
          trade_date: b.trade_date,
          nav: (Number(b.close) / base) * nav0,
        }));
      }
    }
    return { run, nav, benchmark };
  }

  /** P28/P30 杠杆信号最新状态（invest-model leverage_signal 表；EOD+盘中同表，取最新一行）。 */
  async leverageLatest() {
    try {
      const row = await this.db.one(
        'SELECT trade_date, snapshot_ts, and_active, p28_count, close, `median`, fear, detail ' +
        'FROM leverage_signal ORDER BY trade_date DESC, snapshot_ts DESC LIMIT 1'
      );
      if (!row) return null;
      return { ...row, detail: parseJson(row.detail) };
    } catch {
      // 表未建（invest-model 未跑过新计划）→ 前端显示"暂无数据"，不报错
      return null;
    }
  }

  /**
   * 宽基四腿窗口状态（invest-model broad_leg_state 表，与每日计划 hints 同源同数）。
   *
   * latest = 最新决策日的四腿闸位读数；ledger = 该表逐日累积的仓位账本。
   * 账本**以建表当日为起点**——历史仓位只有回测口径（前端走静态 broadIndex.json），
   * 实盘仓位从系统接入这套规则的那天起记，两者在页面上分区呈现、不混。
   */
  /**
   * P70 乖离率读数（提示-only）。owner 2026-08-06：指标入库 + 页面透出，**但不参与任何
   * 买卖决策**——它已在六个口径上全部验证失败（E37/E56/E57/E58/E59/E60）。
   *
   * 排名口径＝**近十年滚动窗口（2500 交易日）内的名次**，rank=1 为窗口内最极端；
   * 进前 4 时 invest-model 会在每日计划里出 🚨 行（→ issue #9 → 邮件）。
   * 前端凡展示这些数的地方必须同屏呈现裁决，`verdict` 随数据一起下发、前端不写死。
   */
  async bias() {
    const VERDICT =
      '乖离率是读数，不是信号。六个口径已全部验证失败：E37（全历史分位高尾，进前 5% 后' +
      '未来 20 日反而 +0.53~+5.70pp）· E56（分位低尾，与价格闸几乎不相交）· E57（全历史' +
      '排名双尾，60 日完全反转）· E58（排名+止盈止损，胜率好但期望差、十年不出手）· ' +
      'E59（近十年滚动排名状态机，七腿跑输买入持有 5.35~7.83pp）· E60（滚动 z 分数短线' +
      '搏反弹，六条判据过五条、卡在触发频次）。四腿买卖判定完全由中位线锚决定，' +
      '乖离率零接线。涨到极值尤其不可作卖出依据——历史上是继续涨。';
    try {
      const last = await this.db.one('SELECT MAX(trade_date) d FROM index_bias_daily');
      const date = last?.d ? String(last.d) : null;
      if (!date) return { date: null, latest: [], history: [], verdict: VERDICT };
      const latest = await this.db.q(
        'SELECT trade_date, code, name, close, ma60, bias60, win_days, rank_low, rank_high, ' +
        'pct_low, extreme FROM index_bias_daily WHERE trade_date = ? ORDER BY rank_low',
        [date]
      );
      // 近一年逐日（画趋势用）；七个指数 × 250 日 ≈ 1750 行
      const history = await this.db.q(
        'SELECT trade_date, code, name, bias60, rank_low, rank_high, extreme ' +
        'FROM index_bias_daily ORDER BY trade_date DESC LIMIT 2000'
      );
      return { date, latest, history: history.reverse(), verdict: VERDICT };
    } catch {
      // 表未建（invest-model 尚未跑过带 P70 落库的计划）→ 前端隐藏该板块
      return { date: null, latest: [], history: [], verdict: VERDICT };
    }
  }

  async broad() {
    try {
      const last = await this.db.one(
        'SELECT MAX(trade_date) d FROM broad_leg_state');
      const date = last?.d ? String(last.d) : null;
      if (!date) return { date: null, latest: [], ledger: [] };
      const latest = await this.db.q(
        // data_date＝该腿价格的真实截止日，可能早于 trade_date（四腿此前只有沪深300
        // 在日更清单里，另三腿吃基底 CSV 末行、一度落后 8 个交易日却完全不可见）。
        // 前端必须在 data_date < trade_date 时显式标注陈旧。
        'SELECT trade_date, leg, etf, close, `median`, buy_line, sell_line, buy_mul, sell_mul, ' +
        'state, fear, bias60, bias_pct, bias_rank, data_date, shares, mkt_value, cost_price ' +
        'FROM broad_leg_state WHERE trade_date = ? ' +
        'ORDER BY leg',
        [date]
      );
      const ledger = await this.db.q(
        'SELECT trade_date, leg, state, close, `median`, buy_line, sell_line, fear, bias60, ' +
        'shares, mkt_value FROM broad_leg_state ORDER BY trade_date DESC LIMIT 2000'
      );
      return { date, latest, ledger: ledger.reverse() };
    } catch {
      // 表未建（invest-model 未跑过带 P27 v2 落库的计划）→ 前端回退到静态回测部分
      return { date: null, latest: [], ledger: [] };
    }
  }

  async fearLatest() {
    const row = await this.db.one(
      'SELECT trade_date, score, level, components, raw FROM fear_daily ORDER BY trade_date DESC LIMIT 1');
    if (!row) return null;
    const daily = { ...row, components: parseJson(row.components), raw: parseJson(row.raw) };
    // 盘中(近似)：若 fear_intraday 有「同一交易日或更新」的快照，则透出为当前值，
    // 并带 intraday=true + snapshot_ts 供前端标注；表缺失/无数据静默回退日频。
    try {
      const intra = await this.db.one(
        'SELECT trade_date, snapshot_ts, score, level, components, raw FROM fear_intraday ' +
        'ORDER BY trade_date DESC, snapshot_ts DESC LIMIT 1');
      if (intra && String(intra.trade_date) >= String(daily.trade_date)) {
        return {
          ...intra,
          components: parseJson(intra.components),
          raw: parseJson(intra.raw),
          intraday: true,
          daily_score: daily.score,       // 保留当日已定格的收盘官方值供对照（可能为空）
        };
      }
    } catch {
      // fear_intraday 表尚未建/无数据 → 回退日频，不影响总览
    }
    return daily;
  }

  async fearSeries(start?: string, end?: string) {
    const where: string[] = [];
    const params: any[] = [];
    if (start) { where.push('trade_date >= ?'); params.push(start); }
    if (end) { where.push('trade_date <= ?'); params.push(end); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.db.q(
      `SELECT trade_date, score, level, components FROM fear_daily ${w} ORDER BY trade_date`,
      params
    );
    return rows.map(r => ({ ...r, components: parseJson(r.components) }));
  }

  /** 系统健康：各数据管道的最新水位 + 影子验证摘要（自动化可观测性）。 */
  async health() {
    const one = async (sql: string) => {
      try {
        const r = await this.db.one(sql);
        return r ? Object.values(r)[0] : null;
      } catch {
        return null;
      }
    };
    const [market, plan, snapshot, alert, review, advisor, fear, shadowN] = await Promise.all([
      one('SELECT MAX(trade_date) v FROM stock_daily'),
      one('SELECT MAX(plan_date) v FROM action_plan'),
      one('SELECT MAX(snapshot_date) v FROM holding_snapshot'),
      one('SELECT MAX(alert_date) v FROM watch_alert'),
      one('SELECT MAX(report_date) v FROM review_report'),
      one('SELECT MAX(rec_date) v FROM advisor_reco'),
      one('SELECT MAX(trade_date) v FROM fear_daily'),
      one('SELECT COUNT(*) v FROM policy_shadow'),
    ]);
    return {
      market_date: market,
      plan_date: plan,
      snapshot_date: snapshot,
      alert_date: alert,
      review_date: review,
      advisor_date: advisor,
      fear_date: fear,
      shadow_signals: Number(shadowN || 0),
    };
  }

  /** 研报速通影子验证：fast(信号次日直入) vs gate(旧严格闸门) 两条虚拟净值对比。 */
  async shadow() {
    let rows: any[] = [];
    try {
      rows = await this.db.q(
        `SELECT signal_date, code, grade, d0_date, d0_close, gate_date, gate_close,
                last_date, last_close, fast_ret, gate_ret
         FROM policy_shadow ORDER BY signal_date DESC, code`
      );
    } catch {
      return { rows: [], summary: null };
    }
    const f = rows.filter(r => r.fast_ret != null).map(r => Number(r.fast_ret));
    const g = rows.filter(r => r.gate_ret != null).map(r => Number(r.gate_ret));
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      rows,
      summary: {
        n: rows.length,
        fast_n: f.length,
        gate_n: g.length,
        fast_avg: avg(f),
        // gate 未触发按 0（踏空）计入组合口径
        gate_avg_portfolio: rows.length
          ? rows.reduce((x, r) => x + Number(r.gate_ret || 0), 0) / rows.length
          : null,
        fast_win: f.length ? f.filter(x => x > 0).length / f.length : null,
      },
    };
  }

  /** 投顾信号实战战绩记分卡：按 来源×等级 的信号买入后真实前瞻收益（系统真实用处的度量）。 */
  async signalScorecard() {
    let rows: any[] = [];
    try {
      rows = await this.db.q(
        `SELECT bucket, label, n, win_rate, mean_ret, median_ret, mean_excess, mean_hold_days
         FROM signal_scorecard
         WHERE as_of = (SELECT MAX(as_of) FROM signal_scorecard)
         ORDER BY FIELD(bucket,'ALL','research','research/A','research/B','research/C','intraday','intraday/A','intraday/B','intraday/C')`
      );
    } catch {
      return { as_of: null, rows: [] };
    }
    let asOf: string | null = null;
    try {
      const r = await this.db.one('SELECT MAX(as_of) v FROM signal_scorecard');
      asOf = r ? (Object.values(r)[0] as string) : null;
    } catch {
      asOf = null;
    }
    return { as_of: asOf, rows };
  }
}
