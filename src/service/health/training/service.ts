import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from '../db';
import { PLAN, SessionKey, SessionLog, SetLog, today as planToday, volumeByGroup, weekOf } from './plan';
import { alternatives, exerciseById, NAME_ZH, search, view } from './catalog';

const toDateStr = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const todayCN = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDate = (s: any): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * 力量训练：计划（training_plan）+ 记录（workout_set）+ 动作库（exercises-dataset）。
 * 处方与加重规则全在 plan.ts（纯函数），这里只做存取。
 */
@Provide()
export class HealthTrainingService {
  @Inject()
  db: HealthDbService;

  async plan(): Promise<{ start: string; overrides: Record<string, string> } | null> {
    const row = await this.db.one<any>('SELECT * FROM training_plan WHERE id = 1');
    if (!row) return null;
    return { start: toDateStr(row.start_date), overrides: row.overrides_json ? JSON.parse(row.overrides_json) : {} };
  }

  /** 开始（或重新开始）计划：开练日默认今天，换过的动作清空。 */
  async start(startDate?: string) {
    const d = isDate(startDate) ? startDate : todayCN();
    await this.db.exec(
      `INSERT INTO training_plan (id, plan_key, start_date, overrides_json) VALUES (1, ?, ?, NULL)
       ON DUPLICATE KEY UPDATE plan_key = VALUES(plan_key), start_date = VALUES(start_date), overrides_json = NULL`,
      [PLAN.key, d]
    );
    return this.today();
  }

  /** 某槽位换动作（只影响当前阶段）；exerciseId 为空则恢复计划默认。 */
  async swap(p: { session: SessionKey; slot: string; exerciseId?: string | null }) {
    const plan = await this.plan();
    if (!plan) throw new Error('还没开始计划');
    if (!PLAN.sessions[p.session]?.some(s => s.key === p.slot)) throw new Error('槽位不存在');
    if (p.exerciseId && !exerciseById(p.exerciseId)) throw new Error('动作不存在');
    const { phase } = weekOf(plan.start, todayCN());
    const k = `${p.session}.${p.slot}.${phase}`;
    const o = { ...plan.overrides };
    if (p.exerciseId) o[k] = p.exerciseId;
    else delete o[k];
    await this.db.exec('UPDATE training_plan SET overrides_json = ? WHERE id = 1', [JSON.stringify(o)]);
    return this.today();
  }

  async history(daysBack = 120, end = todayCN()): Promise<SessionLog[]> {
    const rows = await this.db.q<any>(
      `SELECT session_date, session_key, exercise_id, set_no, weight_kg, reps FROM workout_set
       WHERE session_date BETWEEN ? AND ? ORDER BY session_date, exercise_id, set_no`,
      [shift(end, -daysBack), end]
    );
    const by = new Map<string, SessionLog>();
    for (const r of rows) {
      const date = toDateStr(r.session_date);
      if (!by.has(date)) by.set(date, { date, key: r.session_key, sets: [] });
      by.get(date)!.sets.push({
        exerciseId: r.exercise_id,
        setNo: Number(r.set_no),
        weightKg: r.weight_kg == null ? null : Number(r.weight_kg),
        reps: Number(r.reps),
      });
    }
    return [...by.values()];
  }

  /** 今天的课：没开始计划时返回计划概览，前端显示「开始」。 */
  async today() {
    const plan = await this.plan();
    if (!plan) return { plan: null, overview: this.overview() };
    const t = planToday(plan.start, todayCN(), await this.history(), plan.overrides);
    return { plan: t, overview: this.overview() };
  }

  /** 记一组 / 改一组（reps 为 0 即删除这一组）。 */
  async logSet(p: { date?: string; session: SessionKey; exerciseId: string; slot?: string; setNo: number; weightKg?: number | null; reps: number }) {
    const date = isDate(p.date) ? p.date : todayCN();
    if (p.session !== 'A' && p.session !== 'B') throw new Error('session 只能是 A / B');
    if (!exerciseById(p.exerciseId)) throw new Error('动作不存在');
    const setNo = Math.floor(Number(p.setNo));
    const reps = Math.floor(Number(p.reps));
    const w = p.weightKg == null || (p.weightKg as any) === '' ? null : Number(p.weightKg);
    if (!(setNo >= 1 && setNo <= 10)) throw new Error('组号 1–10');
    if (!(reps >= 0 && reps <= 600)) throw new Error('次数不合法');
    if (w != null && !(w >= 0 && w <= 500)) throw new Error('重量不合法');
    if (reps === 0) {
      await this.db.exec('DELETE FROM workout_set WHERE session_date = ? AND exercise_id = ? AND set_no = ?', [date, p.exerciseId, setNo]);
    } else {
      // 同一天只算一节课：以当天第一条记录的 A/B 为准
      const first = await this.db.one<any>('SELECT session_key FROM workout_set WHERE session_date = ? LIMIT 1', [date]);
      await this.db.exec(
        `INSERT INTO workout_set (session_date, session_key, exercise_id, slot, set_no, weight_kg, reps)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg), reps = VALUES(reps), slot = VALUES(slot)`,
        [date, first?.session_key || p.session, p.exerciseId, p.slot || null, setNo, w, reps]
      );
    }
    return this.today();
  }

  /** 近 days 天练过的日期（并入 Watch 的力量训练天数）。 */
  async trainedDates(daysBack = 21, end = todayCN()): Promise<string[]> {
    const rows = await this.db.q<any>('SELECT DISTINCT session_date AS d FROM workout_set WHERE session_date BETWEEN ? AND ?', [
      shift(end, -daysBack),
      end,
    ]);
    return rows.map(r => toDateStr(r.d));
  }

  /** 周复盘用：区间内的全部组（带日期）。 */
  async setsBetween(from: string, to: string): Promise<Array<SetLog & { date: string }>> {
    const h = await this.history(Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000)), to);
    return h.filter(s => s.date >= from).flatMap(s => s.sets.map(x => ({ ...x, date: s.date })));
  }

  exercise(id: string) {
    const e = exerciseById(id);
    if (!e) throw new Error('动作不存在');
    return { ...view(e), alternatives: alternatives(id) };
  }

  search(p: { q?: string; part?: string; eq?: string }) {
    return search({ ...p, limit: 40 });
  }

  /** 计划概览：三个阶段 × A/B 每个槽位用什么动作。 */
  overview() {
    return {
      key: PLAN.key,
      name: PLAN.name,
      weeks: PLAN.weeks,
      perWeek: PLAN.perWeek,
      minutes: PLAN.minutes,
      phases: PLAN.phases,
      walking: PLAN.walking,
      warmup: PLAN.warmup.text,
      sessions: (['A', 'B'] as SessionKey[]).map(k => ({
        key: k,
        slots: PLAN.sessions[k].map(s => ({
          key: s.key,
          label: s.label,
          byPhase: s.ex.map((id, i) => ({
            exerciseId: id,
            name: NAME_ZH[id] || id,
            sets: s.sets[i],
            reps: s.reps[i],
          })),
        })),
      })),
    };
  }

  volume(sets: SetLog[]) {
    return volumeByGroup(sets);
  }
}
