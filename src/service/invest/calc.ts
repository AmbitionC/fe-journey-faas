/**
 * 纯函数：模型研判(移植自 invest-model action_plan.py)、均线、快照衍生指标。
 * 保持与 Python 端逐字一致，便于对照验证；全部可单测。
 */

const fin = (x: any): number | null => {
  const v = typeof x === 'string' ? parseFloat(x) : x;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** 模型层置信度(0..1)：由交叉验证 IC_IR 映射。IC_IR≥0.6≈满信任，≤0 视为失效。 */
export function modelTrust(icIr: any): number {
  const v = fin(icIr);
  if (v === null) return 0;
  return Math.min(1, Math.max(0, v / 0.6));
}

export function confLabel(trust: number, icIr: any): string {
  const v = fin(icIr);
  if (v === null) return '无（模型未就绪）';
  if (v <= 0) return '失效（IC≤0，勿依赖）';
  return trust >= 0.66 ? '高' : trust >= 0.33 ? '中' : '低';
}

function modelVerdict(mr: number): string {
  if (mr >= 0.85) return '看好';
  if (mr >= 0.65) return '偏多';
  if (mr >= 0.45) return '中性';
  if (mr >= 0.25) return '偏弱';
  return '看淡';
}

/** 单票模型研判：方向 + 全市场分位 + 置信★（决断度×模型信任）。如 "看好 前8% ★★★" */
export function modelView(rankPct: any, trust: number): string {
  const v = fin(rankPct);
  if (v === null) return '—';
  const top = (1 - v) * 100;
  const conviction = Math.abs(v - 0.5) * 2;
  const c = conviction * trust;
  const stars = c >= 0.55 ? '★★★' : c >= 0.28 ? '★★' : '★';
  return `${modelVerdict(v)} 前${top.toFixed(0)}% ${stars}`;
}

/** 简单移动平均：前 window-1 位为 null，与收盘序列等长对齐。 */
export function movingAverage(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (window <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

export interface SnapshotRowInput {
  code: string;
  name?: string;
  asset_type: string; // stock | etf | bond | cash
  shares?: number;
  available?: number;
  cost_price?: number;
  last_price?: number;
  entry_date?: string;
}

export interface SnapshotRowDerived extends SnapshotRowInput {
  market_value: number;
  pnl: number;
  pnl_pct: number; // 百分数（36.56 表示 +36.56%），与快照 CSV 口径一致
  available: number;
}

/** 快照行衍生指标（等价 ingest_holding_snapshot.py 的补算公式）。 */
export function deriveSnapshotRow(r: SnapshotRowInput): SnapshotRowDerived {
  const shares = r.shares ?? 0;
  const cost = r.cost_price ?? 0;
  const last = r.last_price ?? 0;
  const round = (v: number, n: number) => {
    const p = 10 ** n;
    return Math.round(v * p) / p;
  };
  return {
    ...r,
    available: r.available ?? shares,
    market_value: round(shares * last, 2),
    pnl: round((last - cost) * shares, 2),
    pnl_pct: cost > 0 ? round((last / cost - 1) * 100, 4) : 0,
  };
}
