import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from './db';

export interface BodyRecord {
  date: string;
  weightKg: number;
  bmi: number | null;
  bodyFatPct: number | null;
  bodyFatMassKg: number | null;
  muscleMassKg: number | null;
  skeletalMuscleMassKg: number | null;
  visceralFatLevel: number | null;
  subcutaneousFatPct: number | null;
  proteinPct: number | null;
  waterPct: number | null;
  notes: string | null;
}

const NUM_COLS: Array<[keyof BodyRecord, string]> = [
  ['weightKg', 'weight_kg'],
  ['bmi', 'bmi'],
  ['bodyFatPct', 'body_fat_pct'],
  ['bodyFatMassKg', 'body_fat_mass_kg'],
  ['muscleMassKg', 'muscle_mass_kg'],
  ['skeletalMuscleMassKg', 'skeletal_muscle_mass_kg'],
  ['visceralFatLevel', 'visceral_fat_level'],
  ['subcutaneousFatPct', 'subcutaneous_fat_pct'],
  ['proteinPct', 'protein_pct'],
  ['waterPct', 'water_pct'],
];

function rowToRecord(row: any): BodyRecord {
  const dateStr =
    row.record_date instanceof Date
      ? row.record_date.toISOString().slice(0, 10)
      : String(row.record_date).slice(0, 10);
  const rec: any = { date: dateStr, notes: row.notes || null };
  for (const [key, col] of NUM_COLS) {
    rec[key] = row[col] == null ? null : Number(row[col]);
  }
  return rec as BodyRecord;
}

/** 体成分/体重记录：按日期一条，重复提交覆盖更新（只称体重时其余字段留空）。 */
@Provide()
export class HealthBodyService {
  @Inject()
  db: HealthDbService;

  async upsert(
    rec: Partial<BodyRecord> & { date: string; weightKg: number }
  ): Promise<BodyRecord> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date))
      throw new Error('date 需为 YYYY-MM-DD');
    if (!(rec.weightKg > 20 && rec.weightKg < 300))
      throw new Error('weightKg 不合法');
    // BMI 未填时按档案身高自动补算
    let bmi = rec.bmi;
    if (bmi == null) {
      const prof = await this.db.one(
        'SELECT height_cm FROM health_profile WHERE id = 1'
      );
      if (prof?.height_cm) {
        const h = Number(prof.height_cm) / 100;
        bmi = Math.round((rec.weightKg / (h * h)) * 100) / 100;
      }
    }
    const cols = [
      'record_date',
      'weight_kg',
      'bmi',
      'body_fat_pct',
      'body_fat_mass_kg',
      'muscle_mass_kg',
      'skeletal_muscle_mass_kg',
      'visceral_fat_level',
      'subcutaneous_fat_pct',
      'protein_pct',
      'water_pct',
      'notes',
    ];
    const vals = [
      rec.date,
      rec.weightKg,
      bmi ?? null,
      rec.bodyFatPct ?? null,
      rec.bodyFatMassKg ?? null,
      rec.muscleMassKg ?? null,
      rec.skeletalMuscleMassKg ?? null,
      rec.visceralFatLevel ?? null,
      rec.subcutaneousFatPct ?? null,
      rec.proteinPct ?? null,
      rec.waterPct ?? null,
      rec.notes ?? null,
    ];
    const updates = cols
      .filter(c => c !== 'record_date')
      .map(c => `\`${c}\`=VALUES(\`${c}\`)`)
      .join(', ');
    await this.db.exec(
      `INSERT INTO body_composition (${cols.join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})
       ON DUPLICATE KEY UPDATE ${updates}`,
      vals
    );
    const row = await this.db.one(
      'SELECT * FROM body_composition WHERE record_date = ?',
      [rec.date]
    );
    return rowToRecord(row);
  }

  async remove(date: string): Promise<void> {
    await this.db.exec('DELETE FROM body_composition WHERE record_date = ?', [
      date,
    ]);
  }

  async latest(): Promise<BodyRecord | null> {
    const row = await this.db.one(
      'SELECT * FROM body_composition ORDER BY record_date DESC LIMIT 1'
    );
    return row ? rowToRecord(row) : null;
  }

  async list(limit = 100): Promise<BodyRecord[]> {
    const rows = await this.db.q(
      'SELECT * FROM body_composition ORDER BY record_date DESC LIMIT ?',
      [Math.min(Math.max(1, limit), 500)]
    );
    return rows.map(rowToRecord);
  }

  /** 趋势：按时间升序返回最近 days 天记录（画图用）。 */
  async trend(days = 365): Promise<BodyRecord[]> {
    const rows = await this.db.q(
      `SELECT * FROM body_composition
       WHERE record_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY record_date ASC`,
      [Math.min(Math.max(1, days), 3660)]
    );
    return rows.map(rowToRecord);
  }
}
