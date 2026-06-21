import * as assert from 'assert';
import { sm2, scoreToGrade, DEFAULT_SRS } from '../src/service/article/sm2';

const DAY = 86400000;
const NOW = 1_700_000_000_000;

describe('article/sm2.ts — 间隔重复', () => {
  describe('scoreToGrade()', () => {
    it('分档映射', () => {
      assert.strictEqual(scoreToGrade(30), 'again');
      assert.strictEqual(scoreToGrade(50), 'hard');
      assert.strictEqual(scoreToGrade(70), 'good');
      assert.strictEqual(scoreToGrade(90), 'easy');
    });
  });

  describe('sm2()', () => {
    it('首次 good：间隔 1 天，reps=1', () => {
      const n = sm2(DEFAULT_SRS, 'good', NOW);
      assert.strictEqual(n.reps, 1);
      assert.strictEqual(n.interval, 1);
      assert.strictEqual(n.dueAt, NOW + DAY);
    });

    it('第二次 good：间隔 6 天', () => {
      const s1 = sm2(DEFAULT_SRS, 'good', NOW);
      const s2 = sm2(s1, 'good', NOW);
      assert.strictEqual(s2.reps, 2);
      assert.strictEqual(s2.interval, 6);
    });

    it('第三次 good：间隔 = 上次间隔 * ease', () => {
      let s = sm2(DEFAULT_SRS, 'good', NOW);
      s = sm2(s, 'good', NOW);
      const s3 = sm2(s, 'good', NOW);
      assert.strictEqual(s3.reps, 3);
      assert.ok(s3.interval > 6);
    });

    it('again：重置 reps，当天到期', () => {
      let s = sm2(DEFAULT_SRS, 'good', NOW);
      s = sm2(s, 'good', NOW);
      const fail = sm2(s, 'again', NOW);
      assert.strictEqual(fail.reps, 0);
      assert.strictEqual(fail.interval, 0);
      assert.strictEqual(fail.dueAt, NOW);
    });

    it('ease 有下限 1.3', () => {
      let s = { ease: 1.3, interval: 10, reps: 5 };
      const n = sm2(s, 'again', NOW);
      assert.ok(n.ease >= 1.3);
    });

    it('easy 提升 ease', () => {
      const n = sm2(DEFAULT_SRS, 'easy', NOW);
      assert.ok(n.ease >= DEFAULT_SRS.ease);
    });

    it('hard 压缩间隔', () => {
      let s = sm2(DEFAULT_SRS, 'good', NOW); // interval 1, reps1
      s = sm2(s, 'good', NOW); // interval 6, reps2
      const hard = sm2(s, 'hard', NOW); // reps3 → 6*ease*0.8
      const good = sm2(s, 'good', NOW);
      assert.ok(hard.interval <= good.interval);
    });
  });
});
