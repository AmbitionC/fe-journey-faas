import { exerciseById, GROUP_OF, GROUPS, NAME_ZH, weightStep } from './catalog';

/**
 * 12 周新手全身计划（2026-10-10 按本人情况定制：健身房 / 每周 3 次 × 45 分钟 / 新手 / 无伤痛 /
 * 减脂期保肌肉，基线 178 cm、~89 kg、体脂 27%、内脏脂肪 12、久坐、喜欢快走）。
 *
 * - A / B 两套全身课交替（A 蹲+水平推+垂直拉，B 髋铰链+水平拉+垂直推+单腿），不绑定星期几：
 *   练完 A 下次就是 B，适合带娃时间不固定；一周 3 次即 A-B-A / B-A-B。
 * - 三个阶段换动作：1–4 周固定器械学动作（轨迹固定、好上手），5–8 周换哑铃自由重量，
 *   9–12 周上杠铃主项。每个槽位的动作都来自 exercises-dataset（ID 即数据集 ID）。
 * - 加重用「双进阶」：在次数区间内练，所有组都做到区间上限才加重；连续两次没到下限就降 10%。
 *   强度靠「留几个」（RIR）控制：第一阶段留 3 个，之后留 2 个——减脂期不练到力竭，保肌肉够用、恢复也跟得上。
 */

export type SessionKey = 'A' | 'B';

export interface Slot {
  key: string;
  /** 动作模式（显示用） */
  label: string;
  /** 三个阶段各用哪个动作（数据集 ID） */
  ex: [string, string, string];
  sets: [number, number, number];
  reps: [[number, number], [number, number], [number, number]];
  /** 次数单位：次 / 秒（平板支撑、农夫行走按秒） */
  unit?: 'reps' | 'sec';
  /** 和下一个槽位做超级组（交替做、共用休息，省时间） */
  superset?: boolean;
  restSec: number;
  cue: string;
}

export const PLAN = {
  key: 'novice-fullbody-12w',
  name: '12 周新手全身计划',
  weeks: 12,
  perWeek: 3,
  minutes: 45,
  phases: [
    { name: '打基础', weeks: [1, 4], rir: 3, note: '固定器械为主，学动作、找重量，每组留 3 个' },
    { name: '自由重量', weeks: [5, 8], rir: 2, note: '换成哑铃，次数区间 8–12，每组留 2 个' },
    { name: '杠铃主项', weeks: [9, 12], rir: 2, note: '深蹲、卧推、罗马尼亚硬拉上杠铃，主项 6–10 次' },
  ],
  warmup: { exerciseId: '3666', text: '坡度跑步机快走 5 分钟，第一个动作先用空杆/轻重量做 1–2 组热身' },
  /** 非训练日：快走（本人偏好），步数目标随阶段提高 */
  walking: { text: '不练的日子快走 30–45 分钟（微喘能说话）', steps: [8000, 9000, 10000] },
  sessions: {
    A: [
      {
        key: 'squat',
        label: '蹲',
        ex: ['0739', '1760', '0043'],
        sets: [3, 3, 3],
        reps: [
          [12, 15],
          [10, 12],
          [6, 10],
        ],
        restSec: 120,
        cue: '膝盖跟脚尖同向，下到大腿与地面平行，脚跟发力起',
      },
      {
        key: 'hpush',
        label: '水平推',
        ex: ['0577', '0289', '0025'],
        sets: [3, 3, 3],
        reps: [
          [10, 15],
          [8, 12],
          [6, 10],
        ],
        restSec: 120,
        cue: '肩胛先往后下收紧，推的时候不耸肩，下放 2 秒',
      },
      {
        key: 'vpull',
        label: '垂直拉',
        ex: ['2330', '2330', '0818'],
        sets: [3, 3, 3],
        reps: [
          [10, 15],
          [8, 12],
          [8, 12],
        ],
        restSec: 90,
        cue: '先沉肩再拉，手肘往口袋方向拉到下巴附近，别后仰借力',
      },
      {
        key: 'legcurl',
        label: '腿后侧',
        ex: ['0599', '0599', '0599'],
        sets: [2, 3, 3],
        reps: [
          [12, 15],
          [10, 12],
          [10, 12],
        ],
        restSec: 60,
        superset: true,
        cue: '勾脚尖，弯到底停 1 秒，慢放',
      },
      {
        key: 'reardelt',
        label: '肩后束 · 体态',
        ex: ['0602', '0602', '0203'],
        sets: [2, 3, 3],
        reps: [
          [12, 15],
          [12, 15],
          [12, 15],
        ],
        restSec: 60,
        cue: '久坐圆肩的解药：手臂微弯往两侧打开，挤肩胛，别耸肩',
      },
      {
        key: 'core',
        label: '核心',
        ex: ['0276', '0276', '2135'],
        sets: [2, 3, 3],
        reps: [
          [8, 12],
          [10, 15],
          [30, 45],
        ],
        restSec: 45,
        cue: '下背始终贴地（死虫）/ 身体一条线不塌腰（平板）',
      },
    ] as Slot[],
    B: [
      {
        key: 'hinge',
        label: '髋铰链',
        ex: ['0573', '1459', '0085'],
        sets: [3, 3, 3],
        reps: [
          [12, 15],
          [8, 12],
          [6, 10],
        ],
        restSec: 120,
        cue: '屁股往后推、背挺直，重量贴着腿走，感觉大腿后侧拉长',
      },
      {
        key: 'hpull',
        label: '水平拉',
        ex: ['1350', '0861', '0861'],
        sets: [3, 3, 3],
        reps: [
          [10, 15],
          [8, 12],
          [8, 12],
        ],
        restSec: 90,
        cue: '挺胸，手肘贴身往后拉到肚脐，停 1 秒挤背',
      },
      {
        key: 'vpush',
        label: '垂直推',
        ex: ['0603', '0405', '0405'],
        sets: [3, 3, 3],
        reps: [
          [10, 15],
          [8, 12],
          [6, 10],
        ],
        restSec: 90,
        cue: '收腹别塌腰，推到头顶正上方，下放到耳朵高度',
      },
      {
        key: 'single',
        label: '单腿',
        ex: ['0431', '0410', '0410'],
        sets: [2, 3, 3],
        reps: [
          [10, 12],
          [8, 12],
          [8, 12],
        ],
        restSec: 90,
        cue: '每条腿做够次数；前脚整个踩实，躯干稍前倾练臀',
      },
      {
        key: 'triceps',
        label: '手臂 · 三头',
        ex: ['0201', '0201', '0201'],
        sets: [2, 2, 3],
        reps: [
          [12, 15],
          [10, 15],
          [10, 12],
        ],
        restSec: 45,
        superset: true,
        cue: '大臂夹紧身体不动，只动小臂',
      },
      {
        key: 'biceps',
        label: '手臂 · 二头',
        ex: ['0313', '0313', '0313'],
        sets: [2, 2, 3],
        reps: [
          [12, 15],
          [10, 15],
          [10, 12],
        ],
        restSec: 60,
        cue: '拳眼朝上，不甩身体',
      },
      {
        key: 'carry',
        label: '负重行走',
        ex: ['2133', '2133', '2133'],
        sets: [2, 3, 3],
        reps: [
          [30, 40],
          [30, 45],
          [40, 60],
        ],
        unit: 'sec',
        restSec: 60,
        cue: '挺胸收腹，小步快走，握力和核心一起练',
      },
    ] as Slot[],
  },
};

// ------------------------------------------------------------------ 进度与处方

export interface SetLog {
  exerciseId: string;
  setNo: number;
  weightKg: number | null;
  reps: number;
}
export interface SessionLog {
  date: string;
  key: SessionKey;
  sets: SetLog[];
}

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const weekStartOf = (d: string) => {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return new Date(Date.parse(`${d}T00:00:00Z`) - ((dow + 6) % 7) * 86400000).toISOString().slice(0, 10);
};
const round05 = (x: number) => Math.round(x * 2) / 2;

/** 按秒计的动作（平板支撑、农夫行走），其余按次。 */
const SEC_EXERCISES = new Set(['2135', '2133']);
export const unitOf = (slot: Slot, exerciseId: string): 'reps' | 'sec' =>
  SEC_EXERCISES.has(exerciseId) ? 'sec' : slot.unit || 'reps';

/** 第几周（1 起）与阶段（0/1/2）；超过 12 周停在最后阶段并标记完成。 */
export function weekOf(start: string, today: string) {
  const week = Math.floor(days(start, today) / 7) + 1;
  const phase = week <= 4 ? 0 : week <= 8 ? 1 : 2;
  return { week: Math.max(1, week), phase, done: week > PLAN.weeks };
}

export interface Suggestion {
  weightKg: number | null;
  /** 目标次数（自重/按秒的动作靠加次数） */
  targetReps: number | null;
  note: string;
}

/**
 * 双进阶：取这个动作最近两次（不含今天）的记录。
 * - 没有记录：找起始重量（做完还能再做 RIR 个的重量）
 * - 上次所有组都做到区间上限 → 加一档
 * - 上次和上上次都有组没到下限、且重量没变 → 降 10%
 * - 其余保持重量，争取每组多 1 次
 */
export function suggest(exerciseId: string, slot: Slot, phase: number, history: SessionLog[], today: string): Suggestion {
  const [lo, hi] = slot.reps[phase];
  const sets = slot.sets[phase];
  const rir = PLAN.phases[phase].rir;
  const unit = unitOf(slot, exerciseId) === 'sec' ? '秒' : '次';
  const ex = exerciseById(exerciseId);
  const step = ex ? weightStep(ex) : 2.5;
  const past = history
    .filter(s => s.date < today)
    .map(s => ({ date: s.date, sets: s.sets.filter(x => x.exerciseId === exerciseId && x.reps > 0) }))
    .filter(s => s.sets.length)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!past.length)
    return {
      weightKg: null,
      targetReps: lo,
      note: step ? `首次：选一个做 ${lo} ${unit}后还能再做 ${rir} 个的重量` : `首次：每组做到 ${lo}–${hi} ${unit}`,
    };
  const last = past[0].sets;
  const top = Math.max(...last.map(x => x.weightKg ?? 0));
  const atTop = last.filter(x => (x.weightKg ?? 0) === top);
  const allHit = atTop.length >= sets && atTop.every(x => x.reps >= hi);
  const missed = (ss: SetLog[], w: number) => ss.some(x => (x.weightKg ?? 0) === w && x.reps < lo);
  const lastStr = `上次 ${top ? `${top}kg × ` : ''}${atTop.map(x => x.reps).join('/')}`;

  if (!step) {
    // 自重（死虫等）：只加次数，满了提示放慢节奏或换进阶动作
    return allHit
      ? { weightKg: null, targetReps: hi, note: `${lastStr}，已做满 → 放慢节奏，或下阶段换进阶动作` }
      : { weightKg: null, targetReps: Math.min(hi, Math.max(...atTop.map(x => x.reps)) + 1), note: `${lastStr} → 每组多 1 ${unit}` };
  }
  if (allHit) {
    const w = round05(top + step);
    return { weightKg: w, targetReps: lo, note: `${lastStr}，都做满 ${hi} ${unit} → 加到 ${w}kg` };
  }
  if (past[1] && missed(last, top) && missed(past[1].sets, top)) {
    const w = round05(Math.max(step, Math.round((top * 0.9) / step) * step));
    return { weightKg: w, targetReps: lo, note: `${lastStr}，连续两次没到 ${lo} ${unit} → 降到 ${w}kg` };
  }
  return { weightKg: top, targetReps: Math.min(hi, Math.min(...atTop.map(x => x.reps)) + 1), note: `${lastStr} → 保持 ${top}kg，争取每组多 1 ${unit}` };
}

export interface PrescribedItem {
  slot: string;
  label: string;
  exerciseId: string;
  name: string;
  sets: number;
  repLo: number;
  repHi: number;
  unit: 'reps' | 'sec';
  rir: number;
  restSec: number;
  superset: boolean;
  cue: string;
  suggestion: Suggestion;
  /** 今天已记的组 */
  logged: Array<{ setNo: number; weightKg: number | null; reps: number }>;
}

export interface TodayPlan {
  planKey: string;
  start: string;
  week: number;
  phase: number;
  phaseName: string;
  phaseNote: string;
  done: boolean;
  session: SessionKey;
  /** 今天是否已经开练（有记录） */
  started: boolean;
  /** 昨天练过：今天建议快走恢复（仍可练） */
  restSuggested: boolean;
  weekDone: number;
  weekTarget: number;
  steps: number;
  warmup: string;
  walking: string;
  items: PrescribedItem[];
}

/**
 * 今天练什么：今天已有记录就是那一节；否则接着上一节轮换（A→B→A）。
 * overrides：本人在某槽位换过的动作（槽位 → 数据集 ID），优先于计划默认。
 */
export function today(
  start: string,
  todayDate: string,
  history: SessionLog[],
  overrides: Record<string, string> = {}
): TodayPlan {
  const { week, phase, done } = weekOf(start, todayDate);
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const todays = sorted.find(s => s.date === todayDate) || null;
  const before = sorted.filter(s => s.date < todayDate);
  const last = before[before.length - 1] || null;
  const session: SessionKey = todays ? todays.key : last ? (last.key === 'A' ? 'B' : 'A') : 'A';
  const ws = weekStartOf(todayDate);
  const weekDone = sorted.filter(s => s.date >= ws && s.date <= todayDate).length;
  const ph = PLAN.phases[phase];
  const items = PLAN.sessions[session].map(slot => {
    const exerciseId = overrides[`${session}.${slot.key}.${phase}`] || slot.ex[phase];
    return {
      slot: slot.key,
      label: slot.label,
      exerciseId,
      name: NAME_ZH[exerciseId] || exerciseById(exerciseId)?.name || exerciseId,
      sets: slot.sets[phase],
      repLo: slot.reps[phase][0],
      repHi: slot.reps[phase][1],
      unit: unitOf(slot, exerciseId),
      rir: ph.rir,
      restSec: slot.restSec,
      superset: !!slot.superset,
      cue: slot.cue,
      suggestion: suggest(exerciseId, slot, phase, sorted, todayDate),
      logged: (todays?.sets || [])
        .filter(x => x.exerciseId === exerciseId)
        .sort((a, b) => a.setNo - b.setNo)
        .map(x => ({ setNo: x.setNo, weightKg: x.weightKg, reps: x.reps })),
    };
  });
  return {
    planKey: PLAN.key,
    start,
    week,
    phase,
    phaseName: ph.name,
    phaseNote: ph.note,
    done,
    session,
    started: !!todays,
    restSuggested: !todays && !!last && days(last.date, todayDate) === 1,
    weekDone,
    weekTarget: PLAN.perWeek,
    steps: PLAN.walking.steps[phase],
    warmup: PLAN.warmup.text,
    walking: PLAN.walking.text,
    items,
  };
}

/**
 * 每个大肌群的训练组数：目标肌群算 1 组，协同肌群各算 0.5 组（同一大肌群只算一次）。
 * 用于周复盘看哪块练少了。
 */
export function volumeByGroup(sets: SetLog[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(GROUPS.map(g => [g, 0]));
  for (const s of sets) {
    if (s.reps <= 0) continue;
    const e = exerciseById(s.exerciseId);
    if (!e) continue;
    const main = GROUP_OF[e.target];
    if (main && main in out) out[main] += 1;
    const sec = new Set(e.sec.map(m => GROUP_OF[m]).filter(g => g && g !== main));
    for (const g of sec) if (g in out) out[g] += 0.5;
  }
  for (const g of Object.keys(out)) out[g] = Math.round(out[g] * 10) / 10;
  return out;
}
