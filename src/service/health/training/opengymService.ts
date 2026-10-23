import { Provide, Inject } from '@midwayjs/core';
import { HealthDbService } from '../db';
import { PosDbService } from '../../pos/db';
import { cnWallToIso } from '../activity';
import { weekOf } from './plan';
import { OgParsed, parseBackup, planFile, timeBlockOf } from './opengym';

const todayCN = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const toDateStr = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const mondayOf = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
};
const chunks = <T>(xs: T[], n = 200): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * openGym 接入的存取（纯逻辑在 opengym.ts）：
 * - sync：整份备份 → workout_set（source='opengym'）、opengym_workout、pos_time_block（source='opengym'，时间账「健康」）。
 *   声明式对账：只动 opengym 来源的行；网页记的同一组（同日同动作同组号）被 App 记录覆盖。
 * - plan：12 周计划当前（或指定）阶段 → openGym 计划文件。
 */
@Provide()
export class OpenGymService {
  @Inject()
  db: HealthDbService;

  @Inject()
  pos: PosDbService;

  async sync(state: any) {
    const p: OgParsed = parseBackup(state);
    const had = Number((await this.db.one<any>('SELECT COUNT(*) AS n FROM opengym_workout'))?.n || 0);
    if (!p.workouts.length && had > 0)
      throw new Error(`备份里一节课都没有，却要清掉已同步的 ${had} 节——拒绝执行（是不是导出了新装 App 的空备份？）`);

    // 组：按 (日期, 动作, 组号) 对账
    const want = new Map<string, any[]>();
    for (const w of p.workouts)
      for (const s of w.sets) want.set(`${w.date}|${s.exerciseId}|${s.setNo}`, [w.date, w.key, s.exerciseId, s.setNo, s.weightKg, s.reps, s.rir]);
    const old = await this.db.q<any>(`SELECT session_date, exercise_id, set_no FROM workout_set WHERE source = 'opengym'`);
    const oldKeys = new Set(old.map(r => `${toDateStr(r.session_date)}|${r.exercise_id}|${r.set_no}`));
    const gone = [...oldKeys].filter(k => !want.has(k));
    for (const k of gone) {
      const [d, id, n] = k.split('|');
      await this.db.exec(`DELETE FROM workout_set WHERE source = 'opengym' AND session_date = ? AND exercise_id = ? AND set_no = ?`, [d, id, Number(n)]);
    }
    for (const part of chunks([...want.values()]))
      await this.db.exec(
        `INSERT INTO workout_set (session_date, session_key, exercise_id, set_no, weight_kg, reps, rir, source)
         VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, 'opengym')").join(', ')}
         ON DUPLICATE KEY UPDATE session_key = VALUES(session_key), weight_kg = VALUES(weight_kg), reps = VALUES(reps),
           rir = VALUES(rir), source = 'opengym'`,
        part.flat()
      );

    // 课：整表替换（只有 App 来源）
    await this.db.exec('DELETE FROM opengym_workout');
    for (const part of chunks(p.workouts))
      await this.db.exec(
        `INSERT INTO opengym_workout (og_id, session_date, start_at, end_at, name, session_key, set_count, skipped_sets, volume_kg)
         VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON DUPLICATE KEY UPDATE session_date = VALUES(session_date)`,
        part.flatMap(w => [w.ogId, w.date, w.startAt, w.endAt, w.name, w.key, w.sets.length, w.skipped, w.volumeKg])
      );

    // 时间账：每节课一段「健康」实报（只动 opengym 来源）
    const blocks = p.workouts.map(w => ({ w, b: timeBlockOf(w) })).filter(x => x.b);
    await this.pos.exec(`DELETE FROM pos_time_block WHERE source = 'opengym'`);
    for (const part of chunks(blocks))
      await this.pos.exec(
        `INSERT INTO pos_time_block (block_date, start_min, end_min, category, title, kind, source)
         VALUES ${part.map(() => "(?, ?, ?, '健康', ?, 'actual', 'opengym')").join(', ')}`,
        part.flatMap(({ w, b }) => [b!.date, b!.startMin, b!.endMin, `力量训练 ${w.key}（openGym）`])
      );

    const st = await this.status();
    const last = p.workouts[p.workouts.length - 1];
    const lastB = last ? timeBlockOf(last) : null;
    const added = [...want.keys()].filter(k => !oldKeys.has(k)).length;
    const skipped = p.workouts.reduce((s, w) => s + w.skipped, 0);
    const text = [
      `已同步 openGym：共 ${p.workouts.length} 节课、${want.size} 组（新增 ${added}，移除 ${gone.length}）`,
      last
        ? `最近：${last.date.slice(5)} ${last.name || last.key} · ${last.sets.length} 组` +
          (lastB ? ` · ${lastB.endMin - lastB.startMin} 分钟` : '') +
          (last.volumeKg ? ` · 容量 ${last.volumeKg} kg` : '')
        : '',
      `本周力量课 ${st.weekSessions}/3`,
      skipped ? `另有 ${skipped} 组没进训练记录（热身外的计时/有氧，或不在本站动作库）` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return { workouts: p.workouts.length, sets: want.size, added, removed: gone.length, skipped, blocks: blocks.length, ...st, text };
  }

  async status() {
    const today = todayCN();
    const ws = mondayOf(today);
    const s = await this.db.one<any>('SELECT COUNT(*) AS n, MAX(synced_at) AS at, MAX(session_date) AS last FROM opengym_workout');
    const days = await this.db.q<any>(
      `SELECT session_date AS d FROM workout_set WHERE session_date BETWEEN ? AND ?
       UNION SELECT session_date AS d FROM opengym_workout WHERE session_date BETWEEN ? AND ?`,
      [ws, today, ws, today]
    );
    return {
      syncedAt: cnWallToIso(s?.at),
      workoutsTotal: Number(s?.n || 0),
      lastWorkout: s?.last ? toDateStr(s.last) : null,
      weekSessions: new Set(days.map(r => toDateStr(r.d))).size,
    };
  }

  /** phase 传 1–3；不传按计划开练日算当前阶段（没开始计划就是第一阶段）。 */
  async plan(phase?: number) {
    const row = await this.db.one<any>('SELECT start_date, overrides_json FROM training_plan WHERE id = 1');
    const overrides = row?.overrides_json ? JSON.parse(row.overrides_json) : {};
    const ph = phase && phase >= 1 && phase <= 3 ? phase - 1 : row ? weekOf(toDateStr(row.start_date), todayCN()).phase : 0;
    return planFile(ph, overrides, todayCN());
  }
}
