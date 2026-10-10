import * as assert from 'assert';
import { ReviewInput, renderWeekly, weekStartOf, weeklyReview } from '../src/service/pos/review';

const shift = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const cnIso = (d: string, h = 23) => new Date(Date.parse(`${d}T00:00:00Z`) + (h - 8) * 3600000).toISOString();

const TODAY = '2026-10-12'; // 周一：复盘 10-05 ~ 10-11

/** 三周「好」数据：每天消耗 2400、吃 1900、蛋白够、睡 7.5h、每周两次力量、体重每天 −0.1。 */
function base(today = TODAY): ReviewInput {
  const days = Array.from({ length: 21 }, (_, i) => shift(today, i - 21));
  return {
    today,
    budget: { intake: 1900, protein: 140, tdee: 2400, deficitTarget: 500, bmr: 1800 },
    meals: days.map(d => ({ date: d, kcal: 1900, proteinG: 140, meals: 3 })),
    activity: days.map(d => {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      return {
        date: d,
        activeKcal: 600,
        restingKcal: 1800,
        sleepHours: 7.5,
        steps: 8000,
        exerciseMinutes: 30,
        workouts: dow === 2 || dow === 5 ? [{ type: 'Traditional Strength Training' }] : [],
        updatedAt: cnIso(shift(d, 1), 1),
      };
    }),
    body: days.map((d, i) => ({ date: d, weightKg: Math.round((90 - i * 0.1) * 10) / 10, bodyFatPct: 26, muscleMassKg: 61 })),
    goalKg: 85,
  };
}

describe('pos/review 健康周复盘', () => {
  it('周一为一周起点', () => {
    assert.strictEqual(weekStartOf('2026-10-11'), '2026-10-05');
    assert.strictEqual(weekStartOf('2026-10-12'), '2026-10-12');
    assert.strictEqual(weekStartOf('2026-10-07'), '2026-10-05');
  });

  it('好的一周：各项数字 + 没有需要改的', () => {
    const r = weeklyReview(base(), '2026-10-05');
    const c = r.cur;
    assert.strictEqual(r.partial, false);
    assert.strictEqual(c.days, 7);
    assert.strictEqual(c.kcal.completeDays, 7);
    assert.strictEqual(c.kcal.avgDeficit, 500);
    assert.strictEqual(c.kcal.totalDeficit, 3500);
    assert.strictEqual(c.protein.hitDays, 7);
    assert.strictEqual(c.sleep.avg, 7.5);
    assert.strictEqual(c.train.strengthDays, 2);
    assert.strictEqual(c.train.avgSteps, 8000);
    assert.strictEqual(c.body.weightDelta, -0.7);
    assert.strictEqual(c.body.expectedLossKg, 0.5);
    assert.deepStrictEqual(r.focus, ['保持现在的节奏']);
    assert.strictEqual(r.wins.length, 2);
    assert.ok(r.prev, '有上周对比');
    assert.ok(r.goal && r.goal.remainingKg > 0 && r.goal.weeksAtPace! > 0);
  });

  it('差的一周：记不全排第一，最多 3 条重点', () => {
    const inp = base();
    for (const m of inp.meals) if (m.date >= '2026-10-05') m.meals = m.date < '2026-10-08' ? 3 : 1;
    for (const m of inp.meals) m.proteinG = 80;
    for (const a of inp.activity) {
      a.sleepHours = 6;
      a.workouts = [];
    }
    const r = weeklyReview(inp, '2026-10-05');
    assert.strictEqual(r.cur.kcal.completeDays, 3);
    assert.strictEqual(r.focus.length, 3);
    assert.ok(r.focus[0].startsWith('先把饮食记全：7 天里只有 3 天记全'));
    assert.ok(r.focus.some(f => f.startsWith('蛋白')));
  });

  it('掉肌进重点；热量账对不上进重点', () => {
    let inp = base();
    inp.body = inp.body.map((b, i) => ({ ...b, muscleMassKg: 62 - i * 0.06 }));
    let r = weeklyReview(inp, '2026-10-05');
    assert.ok(r.focus.some(f => f.startsWith('掉肌')), r.focus.join('|'));

    inp = base();
    inp.meals.forEach(m => (m.kcal = 1300)); // 缺口 1100 → 理论 −1 kg/周，体重却只降 0.7
    inp.body = inp.body.map(b => ({ ...b, weightKg: 88 }));
    r = weeklyReview(inp, '2026-10-05');
    assert.ok(r.focus.some(f => f.startsWith('热量账对不上')), r.focus.join('|'));
  });

  it('进行中的周只算已结束的日子', () => {
    const r = weeklyReview(base('2026-10-14'), '2026-10-12');
    assert.strictEqual(r.partial, true);
    assert.strictEqual(r.cur.days, 2);
  });

  it('推送正文：重点 + 对比表', () => {
    const text = renderWeekly(weeklyReview(base(), '2026-10-05'));
    assert.ok(text.startsWith('### 📊 10月5日–10月11日 周复盘'));
    assert.ok(text.includes('**下周重点**\n1. 保持现在的节奏'));
    assert.ok(text.includes('| 热量缺口（日均） | +500 kcal | +500 kcal |'));
    assert.ok(text.includes('| 记全天数 | 7/7 | 7/7 |'));
    assert.ok(text.includes('距 85 kg 还差'));
  });
});
