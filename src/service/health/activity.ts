import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from './db';
import { HealthBodyService } from './body';
import { parseSleepSamples } from './sleep';
import { parseVitals, VITALS, weightKg as parseWeight } from './vitals';

export interface ActivityRecord {
  date: string;
  steps: number | null;
  activeKcal: number | null;
  restingKcal: number | null;
  exerciseMinutes: number | null;
  standHours: number | null;
  workouts: Array<{ type: string; minutes: number; kcal?: number }>;
  sleepHours: number | null;
  /** 入睡 / 醒来（北京时间 yyyy-MM-dd HH:mm），有睡眠样本时才有 */
  sleepStart: string | null;
  sleepEnd: string | null;
  weightKg: number | null;
  /** 生理指标（健康 App 样本，见 vitals.ts）：静息心率 / HRV / 最大摄氧量 / 步行心率 / 血氧 / 呼吸频率 / 步行跑步距离 / 体脂 */
  restingHr?: number | null;
  hrvMs?: number | null;
  vo2max?: number | null;
  walkingHr?: number | null;
  spo2Pct?: number | null;
  respRate?: number | null;
  distanceKm?: number | null;
  bodyFatPct?: number | null;
  source: string;
  /** 最近一次同步时间（ISO），盘中多次推送时用于展示数据新鲜度 */
  updatedAt: string | null;
}

export function toDateStr(v: any): string {
  return v instanceof Date
    ? v.toISOString().slice(0, 10)
    : String(v).slice(0, 10);
}

/**
 * DATETIME 列（如 updated_at＝CURRENT_TIMESTAMP）存的是 RDS 的北京时间「墙上时间」，驱动按 FC 实例本地时区（UTC）
 * 解析会整体晚 8 小时。这里取回墙上时间再按 +08:00 解释，得到真实时刻的 ISO。
 */
export function cnWallToIso(v: any): string | null {
  if (v == null || v === '') return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const wall =
    v instanceof Date
      ? `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}T${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
      : String(v).trim().replace(' ', 'T').slice(0, 19);
  const t = Date.parse(`${wall}+08:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function rowToActivity(row: any): ActivityRecord {
  return {
    date: toDateStr(row.record_date),
    steps: row.steps == null ? null : Number(row.steps),
    activeKcal: row.active_kcal == null ? null : Number(row.active_kcal),
    restingKcal: row.resting_kcal == null ? null : Number(row.resting_kcal),
    exerciseMinutes:
      row.exercise_minutes == null ? null : Number(row.exercise_minutes),
    standHours: row.stand_hours == null ? null : Number(row.stand_hours),
    workouts: row.workouts_json ? JSON.parse(row.workouts_json) : [],
    sleepHours: row.sleep_hours == null ? null : Number(row.sleep_hours),
    sleepStart: row.sleep_start ? dt16(row.sleep_start) : null,
    sleepEnd: row.sleep_end ? dt16(row.sleep_end) : null,
    weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
    ...(Object.fromEntries(
      Object.entries(VITALS).map(([k, d]) => [k, row[d.col] == null ? null : Number(row[d.col])])
    ) as Pick<ActivityRecord, 'restingHr' | 'hrvMs' | 'vo2max' | 'walkingHr' | 'spo2Pct' | 'respRate' | 'distanceKm' | 'bodyFatPct'>),
    source: row.source,
    updatedAt: cnWallToIso(row.updated_at),
  };
}

/** DATETIME（库里存的是北京时间）→ 'yyyy-MM-dd HH:mm'。mysql2 把它当本地时间解析成 Date，按本地字段取回。 */
function dt16(v: any): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}`;
  }
  return String(v).slice(0, 16).replace('T', ' ');
}

const WATCH_BODY_NOTE = '来自健康 App 同步';

const num = (v: any): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 活动数据（Apple Watch → iOS 快捷指令每日推送）。
 * 按日期幂等：同一天重复推送覆盖更新。
 */
@Provide()
export class HealthActivityService {
  @Inject()
  db: HealthDbService;

  @Inject()
  bodyService: HealthBodyService;

  /**
   * 快捷指令同步入口。字段全部可选（缺什么留空），带体重时顺手写入体成分表。
   * 兼容 snake_case 与 camelCase 两种字段名（快捷指令里拼 JSON 容易走样）。
   */
  async sync(payload: Record<string, any>): Promise<ActivityRecord> {
    const date = String(payload.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error('date 需为 YYYY-MM-DD');

    const pick = (...keys: string[]) => {
      for (const k of keys) if (payload[k] !== undefined) return payload[k];
      return undefined;
    };

    const steps = num(pick('steps'));
    const activeKcal = num(pick('active_kcal', 'activeKcal', 'activeEnergy'));
    const restingKcal = num(
      pick('resting_kcal', 'restingKcal', 'restingEnergy')
    );
    const exerciseMinutes = num(pick('exercise_minutes', 'exerciseMinutes'));
    const standHours = num(pick('stand_hours', 'standHours'));
    let sleepHours = num(pick('sleep_hours', 'sleepHours'));
    // 睡眠样本优先：并集去重后的真实睡着时长 + 入睡/醒来时刻
    const night = parseSleepSamples(pick('sleep_samples', 'sleepSamples'), date);
    if (night) sleepHours = night.hours;
    // 体重：健康 App 样本文本（「92.2 公斤」/「184.4 斤」）或纯数字
    const weightKg = parseWeight(pick('weight_kg', 'weightKg', 'weight'));
    const vitals = parseVitals(payload);
    const workouts = pick('workouts');
    const source = String(pick('source') || 'ios-shortcut').slice(0, 32);

    const cols = [
      'record_date',
      'steps',
      'active_kcal',
      'resting_kcal',
      'exercise_minutes',
      'stand_hours',
      'workouts_json',
      'sleep_hours',
      'sleep_start',
      'sleep_end',
      'weight_kg',
      ...Object.values(VITALS).map(d => d.col),
      'raw_json',
      'source',
    ];
    const vals = [
      date,
      steps,
      activeKcal,
      restingKcal,
      exerciseMinutes,
      standHours,
      Array.isArray(workouts) && workouts.length
        ? JSON.stringify(workouts)
        : null,
      sleepHours,
      night ? `${night.start}:00` : null,
      night ? `${night.end}:00` : null,
      weightKg,
      ...Object.keys(VITALS).map(k => vitals[k] ?? null),
      JSON.stringify(payload).slice(0, 60000),
      source,
    ];
    // 只覆盖这次推送里带了的字段：睡眠和步数可以分两个快捷指令推，互不抹掉
    const keep = new Set(['raw_json', 'source']);
    const updates = cols
      .filter((c, i) => c !== 'record_date' && (keep.has(c) || vals[i] != null))
      .map(c => `\`${c}\`=VALUES(\`${c}\`)`)
      .join(', ');
    await this.db.exec(
      `INSERT INTO activity_daily (${cols.join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})
       ON DUPLICATE KEY UPDATE ${updates}`,
      vals
    );

    // 带体重时顺手记一条体成分（体重 + 体脂）。当天已有对话 / 网页录的完整体脂秤报告就不碰，免得被只有体重的样本覆盖
    if (weightKg != null) {
      try {
        const cur = await this.db.one('SELECT notes FROM body_composition WHERE record_date = ?', [date]);
        if (!cur || String(cur.notes || '').startsWith(WATCH_BODY_NOTE)) {
          await this.bodyService.upsert({ date, weightKg, bodyFatPct: vitals.bodyFatPct ?? null, notes: WATCH_BODY_NOTE });
        }
      } catch {
        /* 体重写入失败不影响活动同步 */
      }
    }

    const row = await this.db.one(
      'SELECT * FROM activity_daily WHERE record_date = ?',
      [date]
    );
    return rowToActivity(row);
  }

  /** 最近 days 天，升序（画图用）。 */
  async list(days = 30): Promise<ActivityRecord[]> {
    const rows = await this.db.q(
      `SELECT * FROM activity_daily
       WHERE record_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY record_date ASC`,
      [Math.min(Math.max(1, days), 3660)]
    );
    return rows.map(rowToActivity);
  }

  async byDate(date: string): Promise<ActivityRecord | null> {
    const row = await this.db.one(
      'SELECT * FROM activity_daily WHERE record_date = ?',
      [date]
    );
    return row ? rowToActivity(row) : null;
  }
}
