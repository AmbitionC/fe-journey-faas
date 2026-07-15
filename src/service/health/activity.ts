import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from './db';
import { HealthBodyService } from './body';

export interface ActivityRecord {
  date: string;
  steps: number | null;
  activeKcal: number | null;
  restingKcal: number | null;
  exerciseMinutes: number | null;
  standHours: number | null;
  workouts: Array<{ type: string; minutes: number; kcal?: number }>;
  sleepHours: number | null;
  weightKg: number | null;
  source: string;
}

function toDateStr(v: any): string {
  return v instanceof Date
    ? v.toISOString().slice(0, 10)
    : String(v).slice(0, 10);
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
    weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
    source: row.source,
  };
}

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
    const sleepHours = num(pick('sleep_hours', 'sleepHours'));
    const weightKg = num(pick('weight_kg', 'weightKg'));
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
      'weight_kg',
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
      weightKg,
      JSON.stringify(payload).slice(0, 60000),
      source,
    ];
    const updates = cols
      .filter(c => c !== 'record_date')
      .map(c => `\`${c}\`=VALUES(\`${c}\`)`)
      .join(', ');
    await this.db.exec(
      `INSERT INTO activity_daily (${cols.join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})
       ON DUPLICATE KEY UPDATE ${updates}`,
      vals
    );

    // 带体重时顺手记一条体重（覆盖同日，只有体重字段）
    if (weightKg != null && weightKg > 20 && weightKg < 300) {
      try {
        await this.bodyService.upsert({
          date,
          weightKg,
          notes: '来自 Apple Watch 同步',
        });
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
