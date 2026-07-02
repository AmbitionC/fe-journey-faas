import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { modelTrust, modelView } from './calc';

/**
 * 标的池合并视图：活跃投顾信号为底座，拼上模型分位/推荐指数、组合目标权重、
 * 最新计划动作与关注位置、行情与持仓标记。
 */
@Provide()
export class InvestPoolService {
  @Inject()
  db: InvestDbService;

  private async latestVersion(): Promise<string> {
    if (process.env.INVEST_MODEL_VERSION) return process.env.INVEST_MODEL_VERSION;
    const row = await this.db.one(
      'SELECT version FROM model_registry ORDER BY created_at DESC LIMIT 1');
    return row?.version || 'ic_v1';
  }

  async pool(date?: string) {
    const d =
      date || (await this.db.one('SELECT MAX(trade_date) d FROM stock_daily'))?.d;
    if (!d) return { date: null, list: [] };

    // 1) 活跃投顾信号（同票取最新 rec_date）
    const recos = await this.db.q(
      `SELECT rec_date, code, source_type, grade, direction, catalyst, valid_until, source
       FROM advisor_reco
       WHERE rec_date <= ? AND (valid_until IS NULL OR valid_until = '' OR valid_until >= ?)
       ORDER BY rec_date DESC, source_type`,
      [d, d]
    );
    const seen = new Set<string>();
    const base = recos.filter(r => !seen.has(r.code) && seen.add(r.code) !== undefined);
    if (!base.length) return { date: d, list: [] };
    const codes = base.map(r => r.code);
    const ph = codes.map(() => '?').join(',');

    // 2) 模型预测（最新一期）
    const version = await this.latestVersion();
    const predDate = (
      await this.db.one(
        'SELECT MAX(trade_date) d FROM model_prediction WHERE version = ?', [version])
    )?.d;
    const preds = predDate
      ? await this.db.q(
          `SELECT code, score, rank_pct FROM model_prediction
           WHERE version = ? AND trade_date = ? AND code IN (${ph})`,
          [version, predDate, ...codes])
      : [];
    const predMap = new Map(preds.map(p => [p.code, p]));

    // 3) 组合目标（最新一期）
    const tgtDate = (
      await this.db.one(
        'SELECT MAX(trade_date) d FROM portfolio_target WHERE version = ?', [version])
    )?.d;
    const tgts = tgtDate
      ? await this.db.q(
          `SELECT code, weight, \`rank\`, grade tgt_grade, source tgt_source
           FROM portfolio_target
           WHERE version = ? AND trade_date = ? AND code IN (${ph})`,
          [version, tgtDate, ...codes])
      : [];
    const tgtMap = new Map(tgts.map(t => [t.code, t]));

    // 4) 最新计划（动作/关注位置/研判/止损）
    const planDate = (
      await this.db.one('SELECT MAX(plan_date) d FROM action_plan'))?.d;
    const plans = planDate
      ? await this.db.q(
          `SELECT code, action, trigger_hint, model_view, model_rank, stop_price, tgt_weight
           FROM action_plan WHERE plan_date = ? AND code IN (${ph})`,
          [planDate, ...codes])
      : [];
    const planMap = new Map(plans.map(p => [p.code, p]));

    // 5) 名称/行业 + 当日行情 + 持仓标记
    const infos = await this.db.q(
      `SELECT ts_code, name, industry FROM stock_info WHERE ts_code IN (${ph})`, codes);
    const infoMap = new Map(infos.map(i => [i.ts_code, i]));
    const px = await this.db.q(
      `SELECT code, close, pct_chg FROM stock_daily WHERE trade_date = ? AND code IN (${ph})`,
      [d, ...codes]);
    const pxMap = new Map(px.map(p => [p.code, p]));
    const held = await this.db.q(
      `SELECT code FROM current_holding WHERE code IN (${ph})`, codes);
    const heldSet = new Set(held.map(h => h.code));

    // 6) model_view 缺失时用注册表 IC_IR 现算（等价 action_plan._model_view）
    const reg = await this.db.one(
      'SELECT cv_ic_ir FROM model_registry WHERE version = ? ORDER BY created_at DESC LIMIT 1',
      [version]);
    const trust = modelTrust(reg?.cv_ic_ir);

    const list = base.map(r => {
      const pred = predMap.get(r.code);
      const tgt = tgtMap.get(r.code);
      const plan = planMap.get(r.code);
      const info = infoMap.get(r.code);
      const p = pxMap.get(r.code);
      return {
        code: r.code,
        name: info?.name || '',
        industry: info?.industry || '',
        grade: r.grade,
        direction: r.direction,
        catalyst: r.catalyst,
        rec_date: r.rec_date,
        source_type: r.source_type,
        source: r.source,
        valid_until: r.valid_until,
        close: p?.close ?? null,
        pct_chg: p?.pct_chg ?? null,
        score: pred?.score ?? null,
        rank_pct: pred?.rank_pct ?? plan?.model_rank ?? null,
        model_view: plan?.model_view || modelView(pred?.rank_pct, trust),
        weight: tgt?.weight ?? null,
        rank: tgt?.rank ?? null,
        action: plan?.action ?? null,
        trigger_hint: plan?.trigger_hint ?? null,
        stop_price: plan?.stop_price ?? null,
        tgt_weight: plan?.tgt_weight ?? null,
        is_held: heldSet.has(r.code),
      };
    });
    // 排序：持仓中 > 分级 > 模型分位
    const gradeOrder = { A: 0, B: 1, C: 2 };
    list.sort((a, b) =>
      Number(b.is_held) - Number(a.is_held) ||
      (gradeOrder[a.grade] ?? 9) - (gradeOrder[b.grade] ?? 9) ||
      (b.rank_pct ?? -1) - (a.rank_pct ?? -1));
    return { date: d, version, list };
  }
}
