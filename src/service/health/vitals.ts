/**
 * Watch / 健康 App 的生理指标（纯函数）。快捷指令「查找健康样本」把样本直接塞进 JSON 字段时，
 * 每个样本会被转成「数值 + 单位」的文本（如「58 次/分」「42.5 毫秒」「97%」），多个样本之间换行。
 * 这里把这种文本（也接受纯数字 / 数组 / 分号分隔）解析成数，再按指标做聚合与单位换算、范围校验。
 */

export type Agg = 'first' | 'avg' | 'sum';

export interface VitalDef {
  /** activity_daily 列名 */
  col: string;
  /** 快捷指令里可用的字段名（兼容几种写法） */
  keys: string[];
  agg: Agg;
  min: number;
  max: number;
  /** 百分比：≤1 视为小数（0.97 → 97） */
  pct?: boolean;
  digits: number;
}

export const VITALS: Record<string, VitalDef> = {
  restingHr: { col: 'resting_hr', keys: ['resting_hr', 'restingHr', 'resting_heart_rate'], agg: 'first', min: 30, max: 150, digits: 0 },
  hrvMs: { col: 'hrv_ms', keys: ['hrv', 'hrv_ms', 'hrvMs'], agg: 'avg', min: 5, max: 300, digits: 1 },
  vo2max: { col: 'vo2max', keys: ['vo2max', 'vo2_max', 'vo2Max'], agg: 'first', min: 10, max: 90, digits: 1 },
  walkingHr: { col: 'walking_hr', keys: ['walking_hr', 'walkingHr', 'walking_heart_rate'], agg: 'avg', min: 40, max: 200, digits: 0 },
  spo2Pct: { col: 'spo2_pct', keys: ['spo2', 'spo2_pct', 'blood_oxygen'], agg: 'avg', min: 70, max: 100, pct: true, digits: 1 },
  respRate: { col: 'resp_rate', keys: ['resp_rate', 'respiratory_rate', 'respRate'], agg: 'avg', min: 5, max: 40, digits: 1 },
  distanceKm: { col: 'distance_km', keys: ['distance_km', 'distance', 'distanceKm'], agg: 'sum', min: 0, max: 200, digits: 2 },
  bodyFatPct: { col: 'body_fat_pct', keys: ['body_fat', 'body_fat_pct', 'bodyFatPct'], agg: 'first', min: 3, max: 70, pct: true, digits: 1 },
};

interface Reading {
  value: number;
  unit: string;
}

/** 文本 / 数字 / 数组 → [{数值, 单位}]。千分位逗号去掉；一行取第一个数。 */
export function readings(v: any): Reading[] {
  if (v === undefined || v === null || v === '') return [];
  if (typeof v === 'number') return Number.isFinite(v) ? [{ value: v, unit: '' }] : [];
  if (Array.isArray(v)) return v.flatMap(readings);
  if (typeof v === 'object') return readings((v as any).value ?? (v as any).quantity);
  return String(v)
    .split(/[\n\r;；]+/)
    .map(s => s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2').trim())
    .map(s => {
      const m = /-?\d+(?:\.\d+)?/.exec(s);
      return m ? { value: Number(m[0]), unit: s.slice(m.index + m[0].length).trim() } : null;
    })
    .filter((r): r is Reading => r != null && Number.isFinite(r.value));
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** 距离统一成公里：米 / m（且不是 km）→ ÷1000，英里 → ×1.609 */
function toKm(r: Reading): number {
  const u = r.unit.toLowerCase();
  if (/公里|千米|km/.test(u)) return r.value;
  if (/英里|mi/.test(u)) return r.value * 1.609;
  if (/米|^m\b|^m$/.test(u)) return r.value / 1000;
  return r.value;
}

/** 按指标定义聚合；不合法（越界）的样本丢掉，全丢光返回 null。 */
export function vital(def: VitalDef, raw: any, name?: string): number | null {
  let xs = readings(raw).map(r => {
    if (name === 'distanceKm') return toKm(r);
    if (def.pct && (r.value <= 1 || /^0\./.test(String(r.value)))) return r.value * 100;
    return r.value;
  });
  xs = xs.filter(x => x >= def.min && x <= def.max);
  if (!xs.length) return null;
  const v = def.agg === 'first' ? xs[0] : def.agg === 'sum' ? xs.reduce((a, b) => a + b, 0) : xs.reduce((a, b) => a + b, 0) / xs.length;
  return round(v, def.digits);
}

/** 体重：支持「92.2 公斤」「184.4 斤」「203 lb」，取第一个样本。 */
export function weightKg(raw: any): number | null {
  const r = readings(raw)[0];
  if (!r) return null;
  const u = r.unit.toLowerCase();
  const kg = /斤/.test(u) && !/公斤|千克/.test(u) ? r.value / 2 : /lb|磅/.test(u) ? r.value * 0.4536 : r.value;
  return kg > 20 && kg < 300 ? round(kg, 2) : null;
}

/** 一次推送里的全部生理指标：{ restingHr: 58, ... }（没带的不出现）。 */
export function parseVitals(payload: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, def] of Object.entries(VITALS)) {
    const key = def.keys.find(k => payload[k] !== undefined);
    if (key === undefined) continue;
    const v = vital(def, payload[key], name);
    if (v != null) out[name] = v;
  }
  return out;
}

export interface VitalSummary {
  /** 最近一次的值与日期 */
  value: number;
  date: string;
  /** 近 7 天（含今天）有数据的日子的均值 */
  avg7: number | null;
  days7: number;
}

/** 首页「心肺与恢复」：每个指标的最近值 + 近 7 天均值（纯函数，activity 每行可带 VITALS 的字段名）。 */
export function vitalSummary(
  activity: Array<{ date: string } & Partial<Record<string, any>>>,
  today: string,
  names = ['restingHr', 'hrvMs', 'vo2max', 'walkingHr', 'spo2Pct', 'respRate']
): Record<string, VitalSummary> {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const out: Record<string, VitalSummary> = {};
  for (const n of names) {
    const rows = activity.filter(a => a[n] != null && a.date <= today).sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) continue;
    const last = rows[rows.length - 1];
    const wk = rows.filter(a => a.date >= from).map(a => Number(a[n]));
    out[n] = {
      value: Number(last[n]),
      date: last.date,
      avg7: wk.length ? round(wk.reduce((s, x) => s + x, 0) / wk.length, VITALS[n].digits) : null,
      days7: wk.length,
    };
  }
  return out;
}
