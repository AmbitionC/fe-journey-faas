import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { modelTrust, modelView } from './calc';
import { R } from '../../common/base.error.utils';

/**
 * 标的池合并视图：活跃投顾信号为底座，拼上模型分位/推荐指数、组合目标权重、
 * 最新计划动作与关注位置、行情与持仓标记。
 *
 * 容错口径：底座（行情日 + 活跃投顾信号）失败 = 接口失败（带原始错误信息，便于
 * 前端直接展示定位）；其余增强段（模型/组合/计划/行情/持仓）单段失败只降级为空，
 * 不拖垮整个接口——与 overview 的分段兜底一致，此前任何一段抛错都会整接口 500。
 */
@Provide()
export class InvestPoolService {
  @Inject()
  db: InvestDbService;

  /** 增强段软查询：失败记日志并降级，绝不抛出。 */
  private async soft<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      console.error(`[pool] ${label} 查询失败(已降级):`, e?.message || e);
      return fallback;
    }
  }

  private async latestVersion(): Promise<string> {
    if (process.env.INVEST_MODEL_VERSION) return process.env.INVEST_MODEL_VERSION;
    const row = await this.db.one(
      'SELECT version FROM model_registry ORDER BY created_at DESC LIMIT 1');
    return row?.version || 'ic_v1';
  }

  async pool(date?: string) {
    // ── 底座：行情日 + 活跃投顾信号（失败=接口失败，透传原因）─────────────
    let d: string | null | undefined;
    let recos: any[];
    try {
      d = date || (await this.db.one('SELECT MAX(trade_date) d FROM stock_daily'))?.d;
      if (!d) return { date: null, list: [] };
      recos = await this.db.q(
        `SELECT rec_date, code, source_type, grade, direction, catalyst, valid_until, source
         FROM advisor_reco
         WHERE rec_date <= ? AND (valid_until IS NULL OR valid_until = '' OR valid_until >= ?)
         ORDER BY rec_date DESC, source_type`,
        [d, d]
      );
    } catch (e: any) {
      console.error('[pool] 底座查询失败:', e?.message || e);
      throw R.error(`标的池底座查询失败：${e?.message || e}`);
    }
    const seen = new Set<string>();
    const base = recos.filter(r => !seen.has(r.code) && seen.add(r.code) !== undefined);
    if (!base.length) return { date: d, list: [] };
    const codes = base.map(r => r.code);
    const ph = codes.map(() => '?').join(',');

    // ── 增强段：单段失败降级为空，不拖垮接口 ──────────────────────────

    // 1) 模型版本 + 预测（最新一期）
    const version = await this.soft('model_registry 版本', () => this.latestVersion(), 'ic_v1');
    const preds = await this.soft('model_prediction', async () => {
      const predDate = (
        await this.db.one(
          'SELECT MAX(trade_date) d FROM model_prediction WHERE version = ?', [version])
      )?.d;
      return predDate
        ? await this.db.q(
            `SELECT code, score, rank_pct FROM model_prediction
             WHERE version = ? AND trade_date = ? AND code IN (${ph})`,
            [version, predDate, ...codes])
        : [];
    }, []);
    const predMap = new Map(preds.map(p => [p.code, p]));

    // 2) 组合目标（最新一期）
    const tgts = await this.soft('portfolio_target', async () => {
      const tgtDate = (
        await this.db.one(
          'SELECT MAX(trade_date) d FROM portfolio_target WHERE version = ?', [version])
      )?.d;
      return tgtDate
        ? await this.db.q(
            `SELECT code, weight, \`rank\`, grade tgt_grade, source tgt_source
             FROM portfolio_target
             WHERE version = ? AND trade_date = ? AND code IN (${ph})`,
            [version, tgtDate, ...codes])
        : [];
    }, []);
    const tgtMap = new Map(tgts.map(t => [t.code, t]));

    // 3) 最新计划（动作/关注位置/研判/止损）
    const plans = await this.soft('action_plan', async () => {
      const planDate = (
        await this.db.one('SELECT MAX(plan_date) d FROM action_plan'))?.d;
      return planDate
        ? await this.db.q(
            `SELECT code, action, trigger_hint, model_view, model_rank, stop_price, tgt_weight
             FROM action_plan WHERE plan_date = ? AND code IN (${ph})`,
            [planDate, ...codes])
        : [];
    }, []);
    const planMap = new Map(plans.map(p => [p.code, p]));

    // 4) 名称/行业 + 当日行情 + 持仓标记
    const infos = await this.soft('stock_info', () => this.db.q(
      `SELECT ts_code, name, industry FROM stock_info WHERE ts_code IN (${ph})`, codes), []);
    const infoMap = new Map(infos.map(i => [i.ts_code, i]));
    const px = await this.soft('stock_daily 当日行情', () => this.db.q(
      `SELECT code, close, pct_chg FROM stock_daily WHERE trade_date = ? AND code IN (${ph})`,
      [d, ...codes]), []);
    const pxMap = new Map(px.map(p => [p.code, p]));
    const held = await this.soft('current_holding', () => this.db.q(
      `SELECT code FROM current_holding WHERE code IN (${ph})`, codes), []);
    const heldSet = new Set(held.map(h => h.code));

    // 5) model_view 缺失时用注册表 IC_IR 现算（等价 action_plan._model_view）
    const reg = await this.soft('model_registry IC_IR', () => this.db.one(
      'SELECT cv_ic_ir FROM model_registry WHERE version = ? ORDER BY created_at DESC LIMIT 1',
      [version]), null);
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
