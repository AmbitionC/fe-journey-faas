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
    const run = runId
      ? await this.db.one('SELECT * FROM backtest_run WHERE run_id = ?', [runId])
      : await this.db.one('SELECT * FROM backtest_run ORDER BY created_at DESC LIMIT 1');
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

  async fearLatest() {
    const row = await this.db.one(
      'SELECT trade_date, score, level, components, raw FROM fear_daily ORDER BY trade_date DESC LIMIT 1');
    if (!row) return null;
    return { ...row, components: parseJson(row.components), raw: parseJson(row.raw) };
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
