import * as assert from 'assert';
import { computeRadar } from '../src/service/article/radar';

describe('article/radar.ts — 能力雷达', () => {
  it('全部已掌握 → 100', () => {
    const r = computeRadar([
      {
        category: 'JS',
        total: 2,
        states: [{ mastery: 'mastered' }, { mastery: 'mastered' }],
      },
    ]);
    assert.strictEqual(r[0].score, 100);
    assert.strictEqual(r[0].name, 'JS');
  });

  it('掌握度加权：mastered=1, review=0.6, done=0.4', () => {
    const r = computeRadar([
      {
        category: 'React',
        total: 5,
        states: [{ mastery: 'mastered' }, { mastery: 'review' }, { status: 'done' }],
      },
    ]);
    // (1 + 0.6 + 0.4) / 5 = 0.4 → 40
    assert.strictEqual(r[0].score, 40);
    assert.strictEqual(r[0].done, 1);
  });

  it('score 上限 100', () => {
    const r = computeRadar([
      { category: 'X', total: 1, states: [{ mastery: 'mastered' }, { mastery: 'mastered' }] },
    ]);
    assert.strictEqual(r[0].score, 100);
  });

  it('total=0 的类被过滤', () => {
    const r = computeRadar([{ category: 'Empty', total: 0, states: [] }]);
    assert.strictEqual(r.length, 0);
  });

  it('无学习记录 → 0 分但保留维度', () => {
    const r = computeRadar([{ category: 'CSS', total: 3, states: [] }]);
    assert.strictEqual(r[0].score, 0);
    assert.strictEqual(r[0].total, 3);
  });
});
