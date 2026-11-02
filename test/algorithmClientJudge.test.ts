import * as assert from 'assert';
import {
  gradeClientResults,
  supportsClientJudge,
} from '../src/common/algorithmClientJudge';

const cases = [
  { input: '"abcabcbb"', expectedOutput: '3' },
  { input: '"bbbbb"', expectedOutput: '1\r\n' },
];

describe('algorithmClientJudge', () => {
  it('只对 JS/TS 走浏览器判题', () => {
    assert.ok(supportsClientJudge('javascript'));
    assert.ok(supportsClientJudge('typescript'));
    assert.ok(!supportsClientJudge('python'));
    assert.ok(!supportsClientJudge('java'));
  });

  it('按库里的期望输出重新判，忽略首尾空白与换行风格', () => {
    const r = gradeClientResults(cases, [
      { actualOutput: '3\n', runtime: 2 },
      { actualOutput: '1', runtime: 1 },
    ]);
    assert.strictEqual(r.status, 'accepted');
    assert.ok(r.allPassed);
    assert.strictEqual(r.totalRuntime, 3);
    assert.strictEqual(r.results[1].expectedOutput, '1\r\n');
  });

  it('输出不对判答案错误；有报错判运行错误', () => {
    const wrong = gradeClientResults(cases, [
      { actualOutput: '3' },
      { actualOutput: '2' },
    ]);
    assert.strictEqual(wrong.status, 'wrong_answer');
    const err = gradeClientResults(cases, [
      { actualOutput: '3', error: 'TypeError: x is not a function' },
      { actualOutput: '1' },
    ]);
    assert.strictEqual(err.status, 'runtime_error');
    assert.strictEqual(err.results[0].passed, false);
  });

  it('回传条数与用例数不一致直接拒绝', () => {
    assert.throws(
      () => gradeClientResults(cases, [{ actualOutput: '3' }]),
      /数量不一致/
    );
  });

  it('不信任回传的 passed 字段', () => {
    const r = gradeClientResults(cases, [
      { actualOutput: '0', passed: true } as any,
      { actualOutput: '1' },
    ]);
    assert.strictEqual(r.results[0].passed, false);
  });
});
