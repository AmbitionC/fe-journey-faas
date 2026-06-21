import * as assert from 'assert';
import { deriveStreak, aggregateWeak, topTags } from '../src/service/article/insights';

const DAY = 86400000;
const NOW = 1_700_000_000_000;
const today = Math.floor(NOW / DAY) * DAY;

describe('article/insights.ts', () => {
  describe('deriveStreak()', () => {
    it('今天+昨天+前天 → 3', () => {
      assert.strictEqual(
        deriveStreak([today, today - DAY, today - 2 * DAY], NOW),
        3
      );
    });
    it('断档只数到断点', () => {
      assert.strictEqual(
        deriveStreak([today, today - 2 * DAY, today - 3 * DAY], NOW),
        1
      );
    });
    it('最近一次是前天 → 0', () => {
      assert.strictEqual(deriveStreak([today - 2 * DAY], NOW), 0);
    });
    it('从昨天起算', () => {
      assert.strictEqual(deriveStreak([today - DAY, today - 2 * DAY], NOW), 2);
    });
    it('空 → 0', () => {
      assert.strictEqual(deriveStreak([], NOW), 0);
    });
    it('同一天多次只算一天', () => {
      assert.strictEqual(deriveStreak([today, today + 1000, today + 2000], NOW), 1);
    });
  });

  describe('aggregateWeak()', () => {
    it('按标签汇总并排序', () => {
      const w = aggregateWeak([
        { tag: 'react', weight: 1 },
        { tag: 'react', weight: 2 },
        { tag: 'css', weight: 1 },
      ]);
      assert.strictEqual(w[0].tag, 'react');
      assert.strictEqual(w[0].score, 3);
      assert.strictEqual(w[0].evidenceCount, 2);
    });
    it('topN 限制', () => {
      const w = aggregateWeak(
        [
          { tag: 'a', weight: 5 },
          { tag: 'b', weight: 4 },
          { tag: 'c', weight: 3 },
        ],
        2
      );
      assert.strictEqual(w.length, 2);
    });
    it('忽略空标签', () => {
      const w = aggregateWeak([{ tag: '', weight: 3 }]);
      assert.strictEqual(w.length, 0);
    });
  });

  describe('topTags()', () => {
    it('按频次取 Top', () => {
      assert.deepStrictEqual(
        topTags(['js', 'js', 'css', 'react', 'css', 'css'], 2),
        ['css', 'js']
      );
    });
  });
});
