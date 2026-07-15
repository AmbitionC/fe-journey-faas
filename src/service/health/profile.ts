import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from './db';

export interface HealthProfile {
  heightCm: number;
  birthYear: number;
  sex: 'male' | 'female';
  activityFactor: number;
  deficitKcal: number;
  proteinPerKg: number;
  goalWeightKg: number | null;
  goals: Array<{
    horizon: string;
    target: string;
    metric?: string;
    value?: number;
  }>;
  preferences: string | null;
  updatedAt: string | null;
}

/** 个人档案与目标（单用户，固定 id=1）。 */
@Provide()
export class HealthProfileService {
  @Inject()
  db: HealthDbService;

  async get(): Promise<HealthProfile> {
    const row = await this.db.one('SELECT * FROM health_profile WHERE id = 1');
    if (!row) throw new Error('health_profile 未初始化');
    return {
      heightCm: Number(row.height_cm),
      birthYear: Number(row.birth_year),
      sex: row.sex,
      activityFactor: Number(row.activity_factor),
      deficitKcal: Number(row.deficit_kcal),
      proteinPerKg: Number(row.protein_per_kg),
      goalWeightKg:
        row.goal_weight_kg == null ? null : Number(row.goal_weight_kg),
      goals: row.goals_json ? JSON.parse(row.goals_json) : [],
      preferences: row.preferences || null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  async update(patch: Partial<HealthProfile>): Promise<HealthProfile> {
    const sets: string[] = [];
    const params: any[] = [];
    const map: Array<[keyof HealthProfile, string, (v: any) => any]> = [
      ['heightCm', 'height_cm', Number],
      ['birthYear', 'birth_year', Number],
      ['sex', 'sex', String],
      ['activityFactor', 'activity_factor', Number],
      ['deficitKcal', 'deficit_kcal', Number],
      ['proteinPerKg', 'protein_per_kg', Number],
      [
        'goalWeightKg',
        'goal_weight_kg',
        (v: any) => (v == null ? null : Number(v)),
      ],
      ['goals', 'goals_json', (v: any) => JSON.stringify(v || [])],
      [
        'preferences',
        'preferences',
        (v: any) => (v == null ? null : String(v)),
      ],
    ];
    for (const [key, col, cast] of map) {
      if (patch[key] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(cast(patch[key]));
      }
    }
    if (sets.length) {
      await this.db.exec(
        `UPDATE health_profile SET ${sets.join(', ')} WHERE id = 1`,
        params
      );
    }
    return this.get();
  }
}
