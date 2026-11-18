import * as assert from 'assert';
import { GrowthService } from '../src/service/growth';

/** 题卡试点：按模块汇总打开 / 答题人数，知识点再按文章拆。 */
describe('题卡使用情况 practiceSummary', () => {
  function svc(rows: { module: any[]; article: any[] }) {
    const s = new GrowthService();
    s.internalUserIds = ['19900001101'];
    const built: Array<{ select: string; wheres: string[]; params: any }> = [];
    (s as any).eventLogModel = {
      createQueryBuilder: () => {
        const q = { select: '', wheres: [] as string[], params: {} as any };
        built.push(q);
        const chain: any = {
          select: (expr: string, alias: string) => ((q.select = alias), chain),
          addSelect: () => chain,
          where: (w: string, p?: any) => (q.wheres.push(w), Object.assign(q.params, p), chain),
          andWhere: (w: string, p?: any) => (q.wheres.push(w), Object.assign(q.params, p), chain),
          groupBy: () => chain,
          addGroupBy: () => chain,
          getRawMany: async () => (q.select === 'article' ? rows.article : rows.module),
        };
        return chain;
      },
    };
    return { s, built };
  }

  it('按模块和事件汇总人数，知识点按文章拆，排除内部账号', async () => {
    const { s, built } = svc({
      module: [
        { module: 'knowledge', event: 'practice_view', count: '9', users: '6' },
        { module: 'knowledge', event: 'practice_answer', count: '4', users: '2' },
        { module: 'soe', event: 'practice_answer', count: '3', users: '1' },
      ],
      article: [
        { article: 'llm/agent/agent-architecture', event: 'practice_view', users: '3' },
        { article: 'llm/agent/agent-architecture', event: 'practice_answer', users: '1' },
      ],
    });
    const r: any = await s.practiceSummary(14);
    assert.deepStrictEqual(r.modules.knowledge.practice_view, { count: 9, users: 6 });
    assert.strictEqual(r.modules.knowledge.practice_answer.users, 2);
    assert.strictEqual(r.modules.soe.practice_answer.users, 1);
    assert.deepStrictEqual(r.knowledgeArticles['llm/agent/agent-architecture'], {
      practice_view: 3,
      practice_answer: 1,
    });
    assert.strictEqual(built.length, 2);
    for (const q of built) {
      assert.ok(q.wheres.some(w => /NOT IN \(:\.\.\.ex\)/.test(w)));
      assert.deepStrictEqual(q.params.ex, ['19900001101']);
    }
    assert.ok(built[1].wheres.some(w => /= 'knowledge'/.test(w)));
  });

  it('查询失败时返回空结果和 query_failed，不抛错', async () => {
    const s = new GrowthService();
    (s as any).eventLogModel = {
      createQueryBuilder: () => {
        throw new Error('db down');
      },
    };
    const r: any = await s.practiceSummary(7);
    assert.strictEqual(r.error, 'query_failed');
    assert.deepStrictEqual(r.modules, {});
  });
});
