import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from './db';
import { HealthBudgetService } from './budget';

export interface MealItem {
  name: string;
  portion: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface MealRecord {
  id: number;
  date: string;
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  mealTime: string | null;
  source: 'manual' | 'photo';
  items: MealItem[];
  totalKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  notes: string | null;
}

export interface DaySummary {
  date: string;
  totalKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  budgetKcal: number;
  deltaKcal: number;
  mealsLogged: number;
}

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack']);

function toDateStr(v: any): string {
  return v instanceof Date
    ? v.toISOString().slice(0, 10)
    : String(v).slice(0, 10);
}

function rowToMeal(row: any): MealRecord {
  return {
    id: Number(row.id),
    date: toDateStr(row.record_date),
    mealType: row.meal_type,
    mealTime: row.meal_time || null,
    source: row.source,
    items: row.items_json ? JSON.parse(row.items_json) : [],
    totalKcal: Number(row.total_kcal),
    proteinG: Number(row.protein_g),
    carbsG: Number(row.carbs_g),
    fatG: Number(row.fat_g),
    notes: row.notes || null,
  };
}

/** 从 items 汇总营养；items 为空时以传入的 totals 为准（手动只填总数的场景）。 */
function computeTotals(items: MealItem[], fallback?: Partial<MealRecord>) {
  if (items.length) {
    return {
      totalKcal: Math.round(
        items.reduce((s, i) => s + (Number(i.kcal) || 0), 0)
      ),
      proteinG:
        Math.round(
          items.reduce((s, i) => s + (Number(i.proteinG) || 0), 0) * 10
        ) / 10,
      carbsG:
        Math.round(
          items.reduce((s, i) => s + (Number(i.carbsG) || 0), 0) * 10
        ) / 10,
      fatG:
        Math.round(items.reduce((s, i) => s + (Number(i.fatG) || 0), 0) * 10) /
        10,
    };
  }
  return {
    totalKcal: Math.round(Number(fallback?.totalKcal) || 0),
    proteinG: Number(fallback?.proteinG) || 0,
    carbsG: Number(fallback?.carbsG) || 0,
    fatG: Number(fallback?.fatG) || 0,
  };
}

/** 饮食记录：一餐一条，按天聚合并对比预算。 */
@Provide()
export class HealthMealService {
  @Inject()
  db: HealthDbService;

  @Inject()
  budgetService: HealthBudgetService;

  async add(rec: {
    date: string;
    mealType: string;
    mealTime?: string;
    source?: string;
    items?: MealItem[];
    totalKcal?: number;
    proteinG?: number;
    carbsG?: number;
    fatG?: number;
    notes?: string;
  }): Promise<MealRecord> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date))
      throw new Error('date 需为 YYYY-MM-DD');
    if (!MEAL_TYPES.has(rec.mealType))
      throw new Error('mealType 需为 breakfast/lunch/dinner/snack');
    const items = Array.isArray(rec.items) ? rec.items : [];
    const totals = computeTotals(items, rec as any);
    const result = await this.db.exec(
      `INSERT INTO meal_log
        (record_date, meal_type, meal_time, source, items_json, total_kcal, protein_g, carbs_g, fat_g, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.date,
        rec.mealType,
        rec.mealTime || null,
        rec.source === 'photo' ? 'photo' : 'manual',
        items.length ? JSON.stringify(items) : null,
        totals.totalKcal,
        totals.proteinG,
        totals.carbsG,
        totals.fatG,
        rec.notes || null,
      ]
    );
    const row = await this.db.one('SELECT * FROM meal_log WHERE id = ?', [
      result.insertId,
    ]);
    return rowToMeal(row);
  }

  async update(id: number, patch: Partial<MealRecord>): Promise<MealRecord> {
    const existing = await this.db.one('SELECT * FROM meal_log WHERE id = ?', [
      id,
    ]);
    if (!existing) throw new Error(`记录不存在：${id}`);
    const merged = { ...rowToMeal(existing), ...patch };
    if (!MEAL_TYPES.has(merged.mealType)) throw new Error('mealType 不合法');
    const items = Array.isArray(merged.items) ? merged.items : [];
    // items 有变更时按 items 重算；否则以显式传入的 totals 为准
    const totals =
      patch.items !== undefined
        ? computeTotals(items, merged)
        : computeTotals([], merged);
    await this.db.exec(
      `UPDATE meal_log SET record_date=?, meal_type=?, meal_time=?, items_json=?,
        total_kcal=?, protein_g=?, carbs_g=?, fat_g=?, notes=? WHERE id=?`,
      [
        merged.date,
        merged.mealType,
        merged.mealTime || null,
        items.length ? JSON.stringify(items) : null,
        totals.totalKcal,
        totals.proteinG,
        totals.carbsG,
        totals.fatG,
        merged.notes || null,
        id,
      ]
    );
    const row = await this.db.one('SELECT * FROM meal_log WHERE id = ?', [id]);
    return rowToMeal(row);
  }

  async remove(id: number): Promise<void> {
    await this.db.exec('DELETE FROM meal_log WHERE id = ?', [id]);
  }

  /** 某天的全部餐次 + 汇总 vs 预算。 */
  async day(
    date: string
  ): Promise<{ date: string; meals: MealRecord[]; summary: DaySummary }> {
    const rows = await this.db.q(
      'SELECT * FROM meal_log WHERE record_date = ? ORDER BY meal_time IS NULL, meal_time, id',
      [date]
    );
    const meals = rows.map(rowToMeal);
    const budget = await this.budgetService.current();
    const totalKcal = meals.reduce((s, m) => s + m.totalKcal, 0);
    const summary: DaySummary = {
      date,
      totalKcal,
      proteinG: Math.round(meals.reduce((s, m) => s + m.proteinG, 0) * 10) / 10,
      carbsG: Math.round(meals.reduce((s, m) => s + m.carbsG, 0) * 10) / 10,
      fatG: Math.round(meals.reduce((s, m) => s + m.fatG, 0) * 10) / 10,
      budgetKcal: budget.intakeKcal,
      deltaKcal: totalKcal - budget.intakeKcal,
      mealsLogged: meals.length,
    };
    return { date, meals, summary };
  }

  /** 日期区间每日汇总（趋势图/周报用）。budget 用当前预算统一对比。 */
  async range(startDate: string, endDate: string): Promise<DaySummary[]> {
    const rows = await this.db.q(
      `SELECT record_date, SUM(total_kcal) AS kcal, SUM(protein_g) AS protein,
              SUM(carbs_g) AS carbs, SUM(fat_g) AS fat, COUNT(*) AS cnt
       FROM meal_log WHERE record_date BETWEEN ? AND ?
       GROUP BY record_date ORDER BY record_date ASC`,
      [startDate, endDate]
    );
    const budget = await this.budgetService.current();
    return rows.map((r: any) => ({
      date: toDateStr(r.record_date),
      totalKcal: Number(r.kcal),
      proteinG: Number(r.protein),
      carbsG: Number(r.carbs),
      fatG: Number(r.fat),
      budgetKcal: budget.intakeKcal,
      deltaKcal: Number(r.kcal) - budget.intakeKcal,
      mealsLogged: Number(r.cnt),
    }));
  }
}
