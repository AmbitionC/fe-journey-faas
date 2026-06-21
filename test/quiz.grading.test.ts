import * as assert from 'assert';
import {
  gradeObjective,
  scoreToMastery,
  mergeMastery,
  computeScore,
} from '../src/service/quiz/grading';

describe('quiz/grading.ts — 纯函数判分', () => {
  describe('gradeObjective()', () => {
    it('单选：完全匹配为对', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'single', answer: ['B'] }, ['B']),
        true
      );
    });
    it('单选：不匹配为错', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'single', answer: ['B'] }, ['A']),
        false
      );
    });
    it('多选：忽略顺序，集合相等为对', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'multi', answer: ['A', 'C'] }, ['C', 'A']),
        true
      );
    });
    it('多选：少选为错', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'multi', answer: ['A', 'C'] }, ['A']),
        false
      );
    });
    it('填空：大小写/空白不敏感', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'blank', answer: ['Promise'] }, [' promise ']),
        true
      );
    });
    it('填空：支持 | 分隔的多个可接受答案', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'blank', answer: ['闭包|closure'] }, ['closure']),
        true
      );
    });
    it('填空：空数不匹配为错', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'blank', answer: ['a', 'b'] }, ['a']),
        false
      );
    });
    it('简答 qa：返回 null（交 AI 判分）', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'qa', answer: ['要点'] }, ['随便答']),
        null
      );
    });
    it('无标准答案：返回 null', () => {
      assert.strictEqual(
        gradeObjective({ id: 1, type: 'single', answer: null }, ['A']),
        null
      );
    });
  });

  describe('scoreToMastery()', () => {
    it('>=80 → mastered', () => {
      assert.strictEqual(scoreToMastery(80), 'mastered');
      assert.strictEqual(scoreToMastery(100), 'mastered');
    });
    it('<80 → review', () => {
      assert.strictEqual(scoreToMastery(79), 'review');
      assert.strictEqual(scoreToMastery(0), 'review');
    });
  });

  describe('mergeMastery()', () => {
    it('atLeast：只升不降', () => {
      assert.strictEqual(mergeMastery('mastered', 'review', 'atLeast'), 'mastered');
      assert.strictEqual(mergeMastery('new', 'review', 'atLeast'), 'review');
    });
    it('authoritative：以新结果为准可降', () => {
      assert.strictEqual(mergeMastery('mastered', 'review', 'authoritative'), 'review');
    });
    it('current 为空按 new 处理', () => {
      assert.strictEqual(mergeMastery(undefined, 'mastered', 'atLeast'), 'mastered');
    });
  });

  describe('computeScore()', () => {
    it('3/4 → 75', () => {
      assert.deepStrictEqual(computeScore([true, true, true, false]), {
        score: 75,
        correctCount: 3,
        totalCount: 4,
      });
    });
    it('空集合 → 0', () => {
      assert.deepStrictEqual(computeScore([]), {
        score: 0,
        correctCount: 0,
        totalCount: 0,
      });
    });
  });
});
