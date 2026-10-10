import * as assert from 'assert';
import { HealthBudgetService } from '../src/service/health/budget';

/** 用桩替代 DB/档案/体成分依赖，验证预算引擎的核心公式。 */
function makeService(opts: {
  body?: any;
  activityRows?: Array<{ total: number }>;
  profile?: any;
}): HealthBudgetService {
  const svc = new HealthBudgetService();
  (svc as any).profileService = {
    get: async () => ({
      heightCm: 175,
      birthYear: 1990,
      sex: 'male',
      activityFactor: 1.25,
      deficitKcal: 400,
      proteinPerKg: 1.8,
      goalWeightKg: 70,
      goals: [],
      preferences: null,
      updatedAt: null,
      ...(opts.profile || {}),
    }),
  };
  (svc as any).bodyService = {
    latest: async () => opts.body ?? null,
  };
  (svc as any).db = {
    calls: [] as Array<{ sql: string; params: any[] }>,
    async q(sql: string, params: any[] = []) {
      this.calls.push({ sql, params });
      return opts.activityRows ?? [];
    },
  };
  return svc;
}

describe('health/budget.ts 预算引擎', () => {
  it('有体成分（80kg/25%体脂）：BMR 取 Mifflin 与 Katch 均值，TDEE 走系数估算', async () => {
    const svc = makeService({
      body: { weightKg: 80, bodyFatPct: 25 },
    });
    const b = await svc.current();
    // 夹具为虚构数据（本仓公开）。Mifflin: 10*80 + 6.25*175 - 5*年龄 + 5；Katch: 370 + 21.6*60 = 1666
    const age = new Date().getFullYear() - 1990;
    assert.strictEqual(b.basis.bmrMifflin, Math.round(800 + 1093.75 - 5 * age + 5));
    assert.strictEqual(b.basis.bmrKatch, 1666);
    assert.strictEqual(b.basis.tdeeSource, 'estimated');
    assert.strictEqual(b.basis.tdee, Math.round(b.basis.bmr * 1.25));
    // 摄入 = TDEE - 400，且不低于下限
    assert.strictEqual(b.intakeKcal, b.basis.tdee - 400);
    // 蛋白 = 70 * 1.8 = 126
    assert.strictEqual(b.proteinG, 126);
    assert.deepStrictEqual(b.proteinRange, [112, 140]);
  });

  it('近14天实测能量 ≥3 天时 TDEE 升级为实测均值', async () => {
    const svc = makeService({
      body: { weightKg: 88, bodyFatPct: 26 },
      activityRows: [{ total: 2300 }, { total: 2400 }, { total: 2500 }],
    });
    const b = await svc.current();
    assert.strictEqual(b.basis.tdeeSource, 'measured');
    assert.strictEqual(b.basis.tdee, 2400);
    assert.strictEqual(b.intakeKcal, 2000);
  });

  it('实测天数不足 3 天仍走估算', async () => {
    const svc = makeService({
      body: { weightKg: 88, bodyFatPct: 26 },
      activityRows: [{ total: 2300 }, { total: 2400 }],
    });
    const b = await svc.current();
    assert.strictEqual(b.basis.tdeeSource, 'estimated');
  });

  it('无体成分记录时用目标体重估 Mifflin，Katch 缺席', async () => {
    const svc = makeService({ body: null });
    const b = await svc.current();
    assert.strictEqual(b.basis.bmrKatch, null);
    assert.strictEqual(b.basis.bmr, b.basis.bmrMifflin);
  });

  it('摄入预算不会跌破 max(1500, BMR×0.9) 下限（防过度节食）', async () => {
    const svc = makeService({
      body: { weightKg: 80, bodyFatPct: 25 },
      profile: { deficitKcal: 2000 },
    });
    const b = await svc.current();
    assert.ok(b.intakeKcal >= 1500);
    assert.ok(b.intakeKcal >= Math.round(b.basis.bmr * 0.9));
  });

  it('TDEE 实测窗口排除当天（盘中多次同步的不完整数据不得污染均值）', async () => {
    const svc = makeService({ body: { weightKg: 88, bodyFatPct: 26 } });
    await svc.current();
    const db = (svc as any).db;
    const tdeeQuery = db.calls.find((c: any) => c.sql.includes('activity_daily'));
    assert.ok(tdeeQuery, '应查询 activity_daily');
    assert.ok(
      /record_date\s*<\s*\?/.test(tdeeQuery.sql),
      'SQL 应包含 record_date < ?（排除当天）'
    );
    const todayCN = new Date(Date.now() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    assert.ok(
      tdeeQuery.params.includes(todayCN),
      '参数应为北京时间的今天'
    );
  });

  it('宏量拆分：蛋白4+脂肪9+碳水4 卡路里合计不超过预算', async () => {
    const svc = makeService({ body: { weightKg: 80, bodyFatPct: 25 } });
    const b = await svc.current();
    const kcalSum = b.proteinG * 4 + b.fatG * 9 + b.carbsG * 4;
    assert.ok(Math.abs(kcalSum - b.intakeKcal) <= 8, `拆分误差过大：${kcalSum} vs ${b.intakeKcal}`);
  });
});
