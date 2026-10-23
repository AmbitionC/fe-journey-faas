import { exerciseById, PATTERN_ALTS, weightStep } from './catalog';
import { PLAN, SessionKey, unitOf } from './plan';

/**
 * openGym（github.com/DuarteSantos8/openGym，自托管健身 App，iPhone 有 App Store 版）接入：纯函数。
 *
 * 不自建 openGym 服务器：手机 App 本地模式即可用。两条通道——
 * - 计划 → App：把 12 周计划的当前阶段导出成 openGym「计划文件」（opengym_plan:1，见其 lib/plan-share.js），
 *   App 里「计划 › 导入」合并成两套课 A/B，自带双进阶（double）、休息、超级组、替代动作；
 * - 记录 → 本系统：App「设置 › 导出备份（JSON）」走分享面板给快捷指令，POST 到 /health/opengym/sync，
 *   整份备份（含全部历史）解析成组 / 课 / 时间段，按声明式对账写库。
 *
 * 动作 ID 两边是同一套（ExerciseDB v1，经 hasaneyldrm/exercises-dataset）：本地动作库 1324 条 ⊂ openGym 5632 条。
 * 只读其数据格式、不拷贝其代码与文案（AGPL-3.0），动图本站自带。
 */

export const OG_PLAN_FMT = 1;
const LB = 0.45359237;
const r1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- 计划 → openGym 计划文件

export interface OgEx {
  id: string;
  sets: number;
  reps?: number;
  repsMin?: number;
  mode?: 'time' | 'cardio';
  sec?: number;
  min?: number;
  prog?: 'double' | 'time';
  inc?: number;
  restSec?: number;
  sg?: string;
  subs?: string[];
  note?: string;
}

export interface OgPlanFile {
  opengym_plan: number;
  exported: string;
  name: string;
  unit: 'kg';
  week: Record<string, string[]>;
  routines: Array<{ id: string; name: string; emoji: string; prog: 'double'; ex: OgEx[] }>;
  customEx: [];
}

/** 12 周计划某阶段（0/1/2）→ openGym 计划文件。overrides 同 training_plan：`${A|B}.${slot}.${phase}` → 动作 ID。 */
export function planFile(phase: number, overrides: Record<string, string> = {}, today = ''): OgPlanFile {
  const ph = PLAN.phases[phase];
  if (!ph) throw new Error('阶段只能是 0/1/2');
  const routine = (key: SessionKey) => {
    const slots = PLAN.sessions[key];
    const ex: OgEx[] = [{ id: PLAN.warmup.exerciseId, sets: 1, mode: 'cardio', min: 5, note: '热身：坡度快走 5 分钟' }];
    let sg = 0;
    slots.forEach((slot, i) => {
      const id = overrides[`${key}.${slot.key}.${phase}`] || slot.ex[phase];
      const [lo, hi] = slot.reps[phase];
      const e = exerciseById(id);
      const o: OgEx = { id, sets: slot.sets[phase], restSec: slot.restSec };
      if (unitOf(slot, id) === 'sec') {
        o.mode = 'time';
        o.sec = hi;
        o.prog = 'time';
      } else {
        o.reps = hi;
        o.repsMin = lo;
        o.prog = 'double';
        const step = e ? weightStep(e) : 0;
        if (step > 0) o.inc = step;
      }
      // 超级组：本槽位与下一槽位交替做（plan.ts superset 标在前一个上）
      if (slot.superset) o.sg = `ss${++sg}`;
      else if (i > 0 && slots[i - 1].superset) o.sg = `ss${sg}`;
      const subs = (PATTERN_ALTS[slot.key] || []).filter(x => x !== id && exerciseById(x)).slice(0, 3);
      if (subs.length) o.subs = subs;
      o.note = `${slot.cue}；每组留 ${ph.rir} 个`;
      ex.push(o);
    });
    return { id: `pos-${key}-p${phase + 1}`, name: `${key} · ${ph.name}`, emoji: key === 'A' ? '🅰️' : '🅱️', prog: 'double' as const, ex };
  };
  return {
    opengym_plan: OG_PLAN_FMT,
    exported: today,
    name: `${PLAN.name} · 第 ${ph.weeks[0]}–${ph.weeks[1]} 周（${ph.name}）`,
    unit: 'kg',
    week: {},
    routines: [routine('A'), routine('B')],
    customEx: [],
  };
}

// ---------------------------------------------------------------- openGym 备份 → 本系统

export interface OgSet {
  exerciseId: string;
  setNo: number;
  weightKg: number | null;
  reps: number;
  rir: number | null;
}

export interface OgWorkout {
  ogId: string;
  date: string;
  /** 北京时间墙上时间 'YYYY-MM-DD HH:mm:ss'，没有则 null */
  startAt: string | null;
  endAt: string | null;
  name: string;
  key: SessionKey;
  sets: OgSet[];
  /** 不在本地动作库、计时/有氧组等没落进 workout_set 的组数 */
  skipped: number;
  volumeKg: number;
}

export interface OgParsed {
  unit: 'kg' | 'lb';
  workouts: OgWorkout[];
  bodyweight: Array<{ date: string; kg: number }>;
}

const isDate = (s: any): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const PLAN_IDS: Record<SessionKey, Set<string>> = {
  A: new Set(PLAN.sessions.A.flatMap(s => s.ex)),
  B: new Set(PLAN.sessions.B.flatMap(s => s.ex)),
};

/** epoch 毫秒 → 北京时间墙上时间（库里 DATETIME 统一存北京墙上时间，同 activity_daily） */
export function cnWall(ms: any): string | null {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** 课名「A · …」「B …」优先；否则按动作与计划 A/B 的重合数判断；都不沾默认 A。 */
export function sessionKeyOf(name: string, exerciseIds: string[]): SessionKey {
  const m = /^\s*([AB])(?:\s|·|\.|-|:|：|$)/i.exec(name || '');
  if (m) return m[1].toUpperCase() as SessionKey;
  const a = exerciseIds.filter(id => PLAN_IDS.A.has(id)).length;
  const b = exerciseIds.filter(id => PLAN_IDS.B.has(id)).length;
  return b > a ? 'B' : 'A';
}

/**
 * 解析 openGym 整份备份（设置 › 导出备份 的 JSON = 其 /api/data 的 state）。
 * 只取完成的正式组：热身组、计时以外的有氧、没勾完成的组都不算；计时组（平板支撑、农夫行走）秒数记进 reps（同网页记组口径）。
 * 同一天多节课合成一节（本系统一天一课），同动作的组号顺延，不撞唯一键。
 */
export function parseBackup(state: any, known: (id: string) => boolean = id => !!exerciseById(id)): OgParsed {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('不是 openGym 备份文件');
  if (!Array.isArray(state.workouts)) throw new Error('不是 openGym 备份文件（没有 workouts）');
  const unit: 'kg' | 'lb' = state.unit === 'lb' || state.unit === 'lbs' ? 'lb' : 'kg';
  const kg = (w: any) => {
    const n = Number(w);
    if (!Number.isFinite(n) || n <= 0) return null;
    return r1(unit === 'lb' ? n * LB : n);
  };

  const raw = state.workouts
    .filter((w: any) => w && isDate(w.d) && Array.isArray(w.entries))
    .sort((a: any, b: any) => a.d.localeCompare(b.d) || (Number(a.start) || 0) - (Number(b.start) || 0));

  const dayKey = new Map<string, SessionKey>();
  const nextNo = new Map<string, number>(); // `${date}|${exerciseId}` → 已用组号
  const out: OgWorkout[] = [];
  for (const w of raw) {
    const ids: string[] = w.entries.map((e: any) => String(e?.id ?? ''));
    const key = dayKey.get(w.d) || sessionKeyOf(String(w.name || ''), ids);
    dayKey.set(w.d, key);
    const sets: OgSet[] = [];
    let skipped = 0;
    let volume = 0;
    for (const e of w.entries) {
      const id = String(e?.id ?? '');
      for (const s of Array.isArray(e?.sets) ? e.sets : []) {
        if (!s || s.done === false) continue;
        if (s.phase === 'warmup' || s.warmup) continue;
        const timed = Number(s.sec) > 0 && !(Number(s.r) > 0);
        const reps = Math.round(timed ? Number(s.sec) : Number(s.r));
        if (!(reps > 0) || !known(id)) {
          skipped++;
          continue;
        }
        const k = `${w.d}|${id}`;
        const setNo = (nextNo.get(k) || 0) + 1;
        nextNo.set(k, setNo);
        const weightKg = kg(s.w);
        const rir = Number.isFinite(Number(s.rir)) && s.rir !== null && s.rir !== '' ? Number(s.rir) : Number.isFinite(Number(s.rpe)) && s.rpe ? r1(10 - Number(s.rpe)) : null;
        sets.push({ exerciseId: id, setNo, weightKg, reps: Math.min(reps, 600), rir });
        if (weightKg && !timed) volume += weightKg * reps;
      }
    }
    out.push({
      ogId: String(w.id || `${w.d}-${out.length}`).slice(0, 40),
      date: w.d,
      startAt: cnWall(w.start),
      endAt: cnWall(w.end),
      name: String(w.name || '').slice(0, 100),
      key,
      sets,
      skipped,
      volumeKg: Math.round(volume),
    });
  }

  const bodyweight = (Array.isArray(state.bodyweight) ? state.bodyweight : [])
    .filter((b: any) => b && isDate(b.d) && kg(b.w))
    .map((b: any) => ({ date: b.d, kg: kg(b.w)! }));
  return { unit, workouts: out, bodyweight };
}

/** 一节课在时间账里的一段（分钟，跨午夜 end>1440）；没有起止或 <5 分钟 / >4 小时的不记。 */
export function timeBlockOf(w: OgWorkout): { date: string; startMin: number; endMin: number } | null {
  if (!w.startAt || !w.endAt) return null;
  const s = Date.parse(w.startAt.replace(' ', 'T') + 'Z');
  const e = Date.parse(w.endAt.replace(' ', 'T') + 'Z');
  const dur = (e - s) / 60000;
  if (!(dur >= 5 && dur <= 240)) return null;
  const date = w.startAt.slice(0, 10);
  const startMin = Number(w.startAt.slice(11, 13)) * 60 + Number(w.startAt.slice(14, 16));
  return { date, startMin, endMin: startMin + Math.round(dur) };
}
