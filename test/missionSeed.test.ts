import * as assert from 'assert';
import { MISSION_SEED } from '../src/data/missionSeed';
import { MissionService } from '../src/service/mission';

/** 首批题卡种子：内容合法、幂等导入只插库里没有的 slug。 */
describe('mission seed', () => {
  it('三档各一张、字段齐全、slug 唯一、前置文章都挂在 knowledge', () => {
    assert.strictEqual(MISSION_SEED.length, 3);
    assert.deepStrictEqual(MISSION_SEED.map(m => m.tier), ['small', 'medium', 'large']);
    assert.strictEqual(new Set(MISSION_SEED.map(m => m.slug)).size, 3);
    for (const m of MISSION_SEED) {
      assert.strictEqual(m.status, 'published');
      assert.ok(m.requirements.length >= 3 && m.acceptanceCriteria.length >= 3);
      assert.ok(m.acceptanceCriteria.some(c => c.mustPass), `${m.slug} 至少一条必过项`);
      assert.ok(m.prereqArticles.every(a => a.module === 'knowledge' && a.key && a.title));
      assert.ok(m.summary.length <= 255 && m.title.length <= 128);
    }
  });

  it('seedMissions 幂等：已存在的 slug 不动，只插新的', async () => {
    const svc = new MissionService();
    const saved: any[] = [];
    svc.missionModel = {
      find: async ({ where }: any) => {
        // 模拟库里已有第一张
        const wanted: string[] = where.slug._value ?? where.slug.value ?? [];
        return wanted.includes(MISSION_SEED[0].slug) ? [{ slug: MISSION_SEED[0].slug }] : [];
      },
      create: (m: any) => m,
      save: async (rows: any[]) => { saved.push(...rows); return rows; },
    } as any;
    const n = await svc.seedMissions(MISSION_SEED as any);
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(saved.map(m => m.slug), MISSION_SEED.slice(1).map(m => m.slug));
    // 第二次：全都在了，什么也不插
    svc.missionModel.find = async () => MISSION_SEED.map(m => ({ slug: m.slug })) as any;
    assert.strictEqual(await svc.seedMissions(MISSION_SEED as any), 0);
  });
});
