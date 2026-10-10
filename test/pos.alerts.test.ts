import * as assert from 'assert';
import { AlertInput, alertsToPush, deficitDays, deficitSummary, healthAlerts } from '../src/service/pos/alerts';
import { renderComment } from '../src/service/pos/alertPush';

const TODAY = '2026-10-10';
const shift = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** 北京时间某日 23:00 对应的 ISO（UTC 15:00） */
const cnIso = (d: string, h = 23) => new Date(Date.parse(`${d}T00:00:00Z`) + (h - 8) * 3600000).toISOString();

/** 一个「健康」的基线：每天消耗 2400、吃 1900（缺口 500）、蛋白够、睡 7.5h、有力量训练、体重平稳。 */
function base(): AlertInput {
  const days = Array.from({ length: 14 }, (_, i) => shift(TODAY, i - 13));
  return {
    today: TODAY,
    hour: 9,
    budget: { intake: 1900, protein: 140, tdee: 2400, deficitTarget: 500, bmr: 1800 },
    meals: days.filter(d => d < TODAY).map(d => ({ date: d, kcal: 1900, proteinG: 140, meals: 3 })),
    activity: days.map(d => ({
      date: d,
      activeKcal: 600,
      restingKcal: 1800,
      sleepHours: 7.5,
      workouts: d === shift(TODAY, -2) ? [{ type: 'Traditional Strength Training' }] : [],
      // 当天的记录在第二天凌晨被补推＝收盘值；今天的还在盘中
      updatedAt: d < TODAY ? cnIso(shift(d, 1), 1) : cnIso(d, 9),
    })),
    body: Array.from({ length: 20 }, (_, i) => ({
      date: shift(TODAY, -1 - 2 * i),
      weightKg: 88,
      muscleMassKg: 61,
    })).reverse(),
  };
}
const keys = (inp: AlertInput) => healthAlerts(inp).map(a => a.key);
const setMeal = (inp: AlertInput, date: string, patch: Partial<AlertInput['meals'][number]>) => {
  const m = inp.meals.find(x => x.date === date);
  if (m) Object.assign(m, patch);
  else inp.meals.push({ date, kcal: 0, proteinG: 0, meals: 0, ...patch });
};

describe('pos/alerts 健康与热量差预警', () => {
  it('基线：一切正常时没有预警', () => {
    assert.deepStrictEqual(keys(base()), []);
    const s = deficitSummary(base());
    assert.strictEqual(s.avg7, 500);
    assert.strictEqual(s.yesterday!.burnSource, 'day');
  });

  it('当天只推过盘中值时，消耗用 TDEE 均值而不是偏小的盘中值', () => {
    const inp = base();
    const y = inp.activity.find(a => a.date === shift(TODAY, -1))!;
    y.activeKcal = 150; // 下午同步的盘中值
    y.updatedAt = cnIso(y.date, 16);
    const d = deficitDays(inp).find(x => x.date === y.date)!;
    assert.strictEqual(d.burnSource, 'avg');
    assert.strictEqual(d.burn, 2400);
  });

  it('昨天：盈余 / 吃太少 / 没记全', () => {
    let inp = base();
    setMeal(inp, shift(TODAY, -1), { kcal: 2700 });
    assert.ok(keys(inp).includes('kcal-surplus:2026-10-09'));

    inp = base();
    setMeal(inp, shift(TODAY, -1), { kcal: 1200 });
    const low = healthAlerts(inp).find(a => a.key === 'kcal-low:2026-10-09')!;
    assert.ok(low.detail!.includes('1620'));

    inp = base();
    setMeal(inp, shift(TODAY, -1), { meals: 1, kcal: 600 });
    const partial = healthAlerts(inp).find(a => a.key === 'meal-partial:2026-10-09')!;
    assert.strictEqual(partial.title, '昨天只记了 1 餐');
    // 没记全的那天不进 7 日均值
    assert.strictEqual(deficitSummary(inp).completeDays7, 6);
  });

  it('近 7 天：缺口太小 / 太大 / 蛋白长期不足', () => {
    let inp = base();
    inp.meals.forEach(m => (m.kcal = 2300));
    assert.ok(keys(inp).includes('kcal-week-small'));

    inp = base();
    inp.meals.forEach(m => (m.kcal = 1300));
    const k = keys(inp);
    assert.ok(k.includes('kcal-week-big'));

    inp = base();
    inp.meals.forEach(m => (m.proteinG = 90));
    assert.ok(keys(inp).includes('protein-week'));
  });

  it('今天类预警只在晚上 19 点后评估', () => {
    const inp = base();
    assert.ok(!keys(inp).some(k => k.startsWith('meal-none')));
    inp.hour = 20;
    assert.ok(keys(inp).includes('meal-none:2026-10-10'));

    setMeal(inp, TODAY, { kcal: 2600, proteinG: 60, meals: 3 });
    const k = keys(inp);
    assert.ok(k.includes('kcal-today-surplus:2026-10-10'));
    assert.ok(k.includes('protein-today:2026-10-10'));

    setMeal(inp, TODAY, { kcal: 2100, proteinG: 130 });
    assert.deepStrictEqual(
      keys(inp).filter(x => x.endsWith(TODAY)),
      ['kcal-today-over:2026-10-10']
    );
  });

  it('掉肌是红色，排在最前', () => {
    const inp = base();
    inp.body = inp.body.map((b, i) => ({ ...b, weightKg: 90 - i * 0.15, muscleMassKg: 62 - i * 0.08 }));
    const a = healthAlerts(inp);
    assert.strictEqual(a[0].key, 'muscle-loss');
    assert.strictEqual(a[0].level, 'red');
  });

  it('体重：减太快 / 反弹', () => {
    let inp = base();
    // 两天降 0.4 kg ≈ 每周 1.4 kg > 体重 1%
    inp.body = inp.body.map((b, i) => ({ ...b, weightKg: 95 - i * 0.4, muscleMassKg: null }));
    assert.ok(keys(inp).includes('weight-fast'));

    inp = base();
    inp.body = inp.body.map((b, i) => ({ ...b, weightKg: 86 + i * 0.2, muscleMassKg: null }));
    assert.ok(keys(inp).includes('weight-rebound'));
  });

  it('热量账对不上：记账应减 1.7 kg、体重没动', () => {
    const inp = base();
    inp.meals.forEach(m => (m.kcal = 1400)); // 缺口 1000/天
    const a = healthAlerts(inp).find(x => x.key === 'kcal-calibration')!;
    assert.ok(a, '应有校准预警');
    assert.ok(a.title.includes('实际 减 0'));
  });

  it('睡眠：连续 3 晚 <6h 为红色；7 日均 <6.5h 为橙色', () => {
    let inp = base();
    inp.activity.slice(-3).forEach(a => (a.sleepHours = 5.5));
    assert.ok(keys(inp).includes('sleep-short3'));

    inp = base();
    inp.activity.forEach((a, i) => (a.sleepHours = i % 2 ? 6.2 : 6.6));
    assert.ok(keys(inp).includes('sleep-low'));
  });

  it('数据断了：Watch 3 天没同步、8 天没称重；没有训练记录不报力量训练', () => {
    const inp = base();
    inp.activity = inp.activity.filter(a => a.date <= shift(TODAY, -3)).map(a => ({ ...a, workouts: [] }));
    inp.body = inp.body.filter(b => b.date <= shift(TODAY, -8));
    const k = keys(inp);
    assert.ok(k.includes('watch-stale'));
    assert.ok(k.includes('weigh-stale'));
    assert.ok(!k.includes('strength-none'));
  });

  it('推送去重：新出现 / 升级 / 满 7 天才再推', () => {
    const a = [
      { key: 'sleep-low', level: 'warn' as const, domain: 'sleep' as const, title: 't' },
      { key: 'muscle-loss', level: 'red' as const, domain: 'body' as const, title: 't' },
      { key: 'weigh-stale', level: 'warn' as const, domain: 'data' as const, title: 't' },
      { key: 'kcal-surplus:2026-10-09', level: 'warn' as const, domain: 'kcal' as const, title: 't' },
    ];
    const state = new Map<string, any>([
      ['sleep-low', { level: 'warn', active: true, lastPushed: '2026-10-08 08:30:00' }],
      ['muscle-loss', { level: 'warn', active: true, lastPushed: '2026-10-09 08:30:00' }],
      ['weigh-stale', { level: 'warn', active: true, lastPushed: '2026-10-03 08:30:00' }],
    ]);
    assert.deepStrictEqual(
      alertsToPush(a, state, TODAY).map(x => x.key),
      ['muscle-loss', 'weigh-stale', 'kcal-surplus:2026-10-09']
    );
  });

  it('推送正文：头部热量缺口 + 新预警加粗', () => {
    const inp = base();
    const s = deficitSummary(inp);
    const body = renderComment(
      TODAY,
      20,
      s,
      [
        { key: 'a', level: 'red', domain: 'body', title: '掉肌 −0.8 kg（29 天）', detail: '同期体重 −1.8 kg' },
        { key: 'b', level: 'warn', domain: 'sleep', title: '近 7 天平均睡眠 6.3 小时' },
      ],
      new Set(['a'])
    );
    assert.ok(body.startsWith('### 🩺 10月10日 晚'));
    assert.ok(body.includes('昨天缺口 +500 kcal（摄入 1,900 · 消耗 2,400）'));
    assert.ok(body.includes('- 🔴 **掉肌 −0.8 kg（29 天）** — 同期体重 −1.8 kg'));
    assert.ok(body.includes('- 🟠 近 7 天平均睡眠 6.3 小时'));
  });
});
