import * as assert from 'assert';
import { cnWall, parseBackup, planFile, sessionKeyOf, timeBlockOf } from '../src/service/health/training/opengym';
import { PLAN } from '../src/service/health/training/plan';

// openGym 备份里一节课的形状（其 lib/finish-workout.js buildCompletedWorkout）
const at = (hm: string, d = '2026-10-23') => Date.parse(`${d}T${hm}:00+08:00`);
const workout = (over: any = {}) => ({
  id: 'w1',
  d: '2026-10-23',
  start: at('12:02'),
  end: at('12:48'),
  name: 'A · 打基础',
  entries: [
    {
      id: '0739',
      sets: [
        { w: 20, r: 10, done: true, phase: 'warmup' },
        { w: 60, r: 15, done: true, rir: 3 },
        { w: 60, r: 13, done: true, rpe: 8 },
        { w: 60, r: 12, done: false },
      ],
    },
    { id: '2133', sets: [{ w: 16, sec: 40, done: true }] },
    { id: '9999', sets: [{ w: 10, r: 10, done: true }] },
  ],
  ...over,
});

describe('openGym 接入', () => {
  describe('计划 → openGym 计划文件', () => {
    it('三个阶段各出 A/B 两套课：热身 + 计划槽位，双进阶区间、加重步长、休息都来自 plan.ts', () => {
      for (const ph of [0, 1, 2]) {
        const f = planFile(ph, {}, '2026-10-23');
        assert.strictEqual(f.opengym_plan, 1);
        assert.strictEqual(f.unit, 'kg');
        assert.deepStrictEqual(f.routines.map(r => r.name.slice(0, 1)), ['A', 'B']);
        for (const r of f.routines) {
          const slots = PLAN.sessions[r.name.slice(0, 1) as 'A' | 'B'];
          assert.strictEqual(r.ex.length, slots.length + 1);
          assert.deepStrictEqual(r.ex[0], { id: PLAN.warmup.exerciseId, sets: 1, mode: 'cardio', min: 5, note: '热身：坡度快走 5 分钟' });
          slots.forEach((s, i) => {
            const e = r.ex[i + 1];
            assert.strictEqual(e.id, s.ex[ph]);
            assert.strictEqual(e.sets, s.sets[ph]);
            assert.strictEqual(e.restSec, s.restSec);
            if (e.mode === 'time') assert.strictEqual(e.sec, s.reps[ph][1]);
            else {
              assert.strictEqual(e.prog, 'double');
              assert.deepStrictEqual([e.repsMin, e.reps], s.reps[ph]);
            }
            assert.ok(!(e.subs || []).includes(e.id), '替代动作不含自己');
            assert.ok(e.note!.includes(`留 ${PLAN.phases[ph].rir} 个`));
          });
        }
      }
    });

    it('超级组成对共用同一个 sg；计时动作（农夫行走）走 time；杠铃深蹲加重步长 5、哑铃 2', () => {
      const p3 = planFile(2);
      for (const r of p3.routines) {
        const groups = new Map<string, number>();
        r.ex.filter(e => e.sg).forEach(e => groups.set(e.sg!, (groups.get(e.sg!) || 0) + 1));
        assert.ok([...groups.values()].every(n => n === 2), `${r.name} 超级组应两两成对`);
      }
      const all = p3.routines.flatMap(r => r.ex);
      assert.strictEqual(all.find(e => e.id === '2133')!.mode, 'time');
      assert.strictEqual(all.find(e => e.id === '0043')!.inc, 5);
      assert.strictEqual(planFile(1).routines.flatMap(r => r.ex).find(e => e.id === '0289')!.inc, 2);
    });

    it('本人在网站换过的动作（overrides）带进计划文件，只影响对应阶段', () => {
      const f = planFile(0, { 'A.squat.0': '1760', 'A.squat.1': '0043' });
      assert.strictEqual(f.routines[0].ex[1].id, '1760');
      assert.ok(planFile(0).routines[0].ex[1].id === '0739');
      assert.throws(() => planFile(3), /阶段/);
    });
  });

  describe('openGym 备份 → 训练记录', () => {
    it('只取完成的正式组：热身、没勾完成的不算；计时组秒数记进 reps；不在本站动作库的跳过并计数', () => {
      const p = parseBackup({ unit: 'kg', workouts: [workout()], bodyweight: [] });
      assert.strictEqual(p.workouts.length, 1);
      const w = p.workouts[0];
      assert.strictEqual(w.key, 'A');
      assert.deepStrictEqual(
        w.sets.map(s => [s.exerciseId, s.setNo, s.weightKg, s.reps, s.rir]),
        [
          ['0739', 1, 60, 15, 3],
          ['0739', 2, 60, 13, 2], // RPE 8 → RIR 2
          ['2133', 1, 16, 40, null],
        ]
      );
      assert.strictEqual(w.skipped, 1);
      assert.strictEqual(w.volumeKg, 60 * 15 + 60 * 13);
      assert.strictEqual(w.startAt, '2026-10-23 12:02:00');
      assert.deepStrictEqual(timeBlockOf(w), { date: '2026-10-23', startMin: 722, endMin: 768 });
    });

    it('磅换算成公斤；体重记录一并解析', () => {
      const p = parseBackup({
        unit: 'lb',
        workouts: [workout({ entries: [{ id: '0025', sets: [{ w: 135, r: 8, done: true }] }] })],
        bodyweight: [{ d: '2026-10-23', w: 198.9, t: 1 }],
      });
      assert.strictEqual(p.workouts[0].sets[0].weightKg, 61.2);
      assert.deepStrictEqual(p.bodyweight, [{ date: '2026-10-23', kg: 90.2 }]);
    });

    it('同一天两节课合成一节：A/B 以当天第一节为准，同动作组号顺延不撞唯一键', () => {
      const p = parseBackup({
        workouts: [
          workout({ id: 'w2', start: at('19:00'), end: at('19:30'), name: 'B · 打基础', entries: [{ id: '0739', sets: [{ w: 65, r: 12, done: true }] }] }),
          workout(),
        ],
      });
      assert.deepStrictEqual(p.workouts.map(w => w.ogId), ['w1', 'w2']);
      assert.deepStrictEqual(p.workouts.map(w => w.key), ['A', 'A']);
      assert.deepStrictEqual(p.workouts[1].sets.map(s => s.setNo), [3]);
    });

    it('课名认 A/B；不是计划里的课按动作和 A/B 的重合判断', () => {
      assert.strictEqual(sessionKeyOf('B · 自由重量', []), 'B');
      assert.strictEqual(sessionKeyOf('b 腿日', []), 'B');
      assert.strictEqual(sessionKeyOf('Back day', ['0573', '1350', '0603']), 'B');
      assert.strictEqual(sessionKeyOf('Pull Day', ['9999']), 'A');
    });

    it('不是 openGym 备份就报错；时间段过短、过长或缺起止不记', () => {
      assert.throws(() => parseBackup(null), /不是 openGym 备份/);
      assert.throws(() => parseBackup({ routines: [] }), /没有 workouts/);
      assert.throws(() => parseBackup([]), /不是 openGym 备份/);
      const one = (s: number, e: number) => parseBackup({ workouts: [workout({ start: s, end: e })] }).workouts[0];
      assert.strictEqual(timeBlockOf(one(at('12:00'), at('12:03'))), null);
      assert.strictEqual(timeBlockOf(one(at('08:00'), at('13:00'))), null);
      assert.strictEqual(timeBlockOf(one(0, 0)), null);
      assert.strictEqual(cnWall(Date.parse('2026-10-23T04:00:00Z')), '2026-10-23 12:00:00');
    });
  });
});
