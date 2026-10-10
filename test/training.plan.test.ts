import * as assert from 'assert';
import { PLAN, SessionLog, suggest, today, volumeByGroup, weekOf } from '../src/service/health/training/plan';
import { alternatives, exerciseById, GYM_EQ, NAME_ZH, search } from '../src/service/health/training/catalog';
import { EXERCISES } from '../src/service/health/training/exercises.data';

const START = '2026-10-12'; // 周一开练
const slot = (k: string, s: 'A' | 'B' = 'A') => PLAN.sessions[s].find(x => x.key === k)!;
const log = (date: string, key: 'A' | 'B', id: string, ws: Array<[number | null, number]>): SessionLog => ({
  date,
  key,
  sets: ws.map(([w, r], i) => ({ exerciseId: id, setNo: i + 1, weightKg: w, reps: r })),
});

describe('training 动作库与 12 周计划', () => {
  it('动作库 1324 条，带中文步骤；计划里每个动作都在库里、有中文名', () => {
    assert.strictEqual(EXERCISES.length, 1324);
    assert.ok(EXERCISES.every(e => e.steps.length > 0));
    assert.ok(!EXERCISES.some(e => /в°/.test(e.name)), '上游乱码已修');
    for (const s of [...PLAN.sessions.A, ...PLAN.sessions.B])
      for (const id of s.ex) {
        assert.ok(exerciseById(id), `缺 ${id}`);
        assert.ok(NAME_ZH[id], `缺中文名 ${id}`);
      }
    assert.ok(exerciseById(PLAN.warmup.exerciseId));
  });

  it('周数与阶段：1–4 打基础、5–8 自由重量、9–12 杠铃，12 周后标记完成', () => {
    assert.deepStrictEqual(weekOf(START, START), { week: 1, phase: 0, done: false });
    assert.deepStrictEqual(weekOf(START, '2026-11-09'), { week: 5, phase: 1, done: false });
    assert.deepStrictEqual(weekOf(START, '2026-12-07'), { week: 9, phase: 2, done: false });
    assert.strictEqual(weekOf(START, '2027-01-04').done, true);
  });

  it('A/B 轮换不绑星期：没练过是 A，上次 A 今天就是 B；今天已练就显示那一节', () => {
    assert.strictEqual(today(START, START, []).session, 'A');
    const h = [log('2026-10-12', 'A', '0739', [[60, 15]])];
    const t = today(START, '2026-10-14', h);
    assert.strictEqual(t.session, 'B');
    assert.strictEqual(t.started, false);
    assert.strictEqual(t.weekDone, 1);
    const t2 = today(START, '2026-10-14', [...h, log('2026-10-14', 'B', '0573', [[20, 12]])]);
    assert.strictEqual(t2.session, 'B');
    assert.strictEqual(t2.started, true);
    assert.strictEqual(t2.items.find(i => i.slot === 'hinge')!.logged.length, 1);
    assert.strictEqual(today(START, '2026-10-13', h).restSuggested, true);
  });

  it('双进阶：首次找重量 / 都做满加一档 / 没做满保持 / 连续两次没到下限降 10%', () => {
    const s = slot('squat'); // 第一阶段 45° 倒蹬 3×12–15，下肢 +5
    assert.ok(suggest('0739', s, 0, [], START).note.startsWith('首次'));

    let r = suggest('0739', s, 0, [log('2026-10-12', 'A', '0739', [[60, 15], [60, 15], [60, 15]])], '2026-10-14');
    assert.strictEqual(r.weightKg, 65);

    r = suggest('0739', s, 0, [log('2026-10-12', 'A', '0739', [[60, 15], [60, 13], [60, 12]])], '2026-10-14');
    assert.strictEqual(r.weightKg, 60);
    assert.strictEqual(r.targetReps, 13);

    r = suggest(
      '0739',
      s,
      0,
      [log('2026-10-12', 'A', '0739', [[80, 12], [80, 10], [80, 9]]), log('2026-10-16', 'A', '0739', [[80, 11], [80, 9], [80, 9]])],
      '2026-10-19'
    );
    assert.strictEqual(r.weightKg, 70); // 80×0.9=72 → 按 5kg 一档取 70
  });

  it('哑铃 +2kg；自重动作只加次数', () => {
    const r = suggest('1760', slot('squat'), 1, [log('2026-11-09', 'A', '1760', [[20, 12], [20, 12], [20, 12]])], '2026-11-11');
    assert.strictEqual(r.weightKg, 22);
    const c = suggest('0276', slot('core'), 0, [log('2026-10-12', 'A', '0276', [[null, 9], [null, 8]])], '2026-10-14');
    assert.strictEqual(c.weightKg, null);
    assert.strictEqual(c.targetReps, 10);
  });

  it('平板支撑、农夫行走按秒', () => {
    const t = today(START, '2026-12-07', []);
    assert.strictEqual(t.items.find(i => i.slot === 'core')!.unit, 'sec');
    const b = today(START, '2026-10-14', [log(START, 'A', '0739', [[60, 12]])]);
    assert.strictEqual(b.items.find(i => i.slot === 'carry')!.unit, 'sec');
  });

  it('换过的动作优先于计划默认', () => {
    const t = today(START, START, [], { 'A.squat.0': '1760' });
    assert.strictEqual(t.items[0].exerciseId, '1760');
    assert.strictEqual(t.items[0].name, '哑铃高脚杯深蹲');
  });

  it('训练量按大肌群：目标 1 组、协同 0.5 组', () => {
    const v = volumeByGroup([
      { exerciseId: '0577', setNo: 1, weightKg: 40, reps: 12 }, // 胸，协同 三头/肩
      { exerciseId: '0577', setNo: 2, weightKg: 40, reps: 0 },
    ]);
    assert.strictEqual(v['胸'], 1);
    assert.strictEqual(v['手臂'], 0.5);
    assert.strictEqual(v['肩'], 0.5);
  });

  it('替代动作同目标肌群、健身房有的器械、不重复视角；搜索支持中文名', () => {
    const alts = alternatives('0577');
    assert.ok(alts.length > 5);
    assert.ok(alts.every(a => a.target === '胸大肌'));
    assert.ok(alts.every(a => GYM_EQ.has(exerciseById(a.id)!.eq)));
    assert.ok(alts[0].name !== alts[0].nameEn, '有中文名的排前');
    assert.ok(search({ q: '卧推' }).some(x => x.id === '0289'));
    assert.ok(exerciseById('0289') && alternatives('0289').every(a => !/\((side|back) pov\)/.test(a.nameEn)));
  });
});
