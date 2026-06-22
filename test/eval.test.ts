import * as assert from 'assert';
import {
  hasCitation,
  citationHit,
  isHintSpoiler,
  verdictMatch,
  aggregate,
} from '../src/eval/metrics';
import { runEval } from '../src/eval/runner';

describe('eval/metrics.ts', () => {
  it('hasCitation 识别延伸阅读/编号', () => {
    assert.strictEqual(hasCitation('详见延伸阅读：《Promise 详解》'), true);
    assert.strictEqual(hasCitation('参考[1]'), true);
    assert.strictEqual(hasCitation('就是这样'), false);
  });
  it('citationHit 取交集', () => {
    assert.strictEqual(citationHit(['a', 'b'], ['b', 'c']), true);
    assert.strictEqual(citationHit(['a'], ['c']), false);
  });
  it('isHintSpoiler 检测答案泄露', () => {
    assert.strictEqual(isHintSpoiler('可以用哈希表降到 O(n)', ['哈希表']), true);
    assert.strictEqual(isHintSpoiler('先想想用什么数据结构', ['哈希表']), false);
  });
  it('verdictMatch', () => {
    assert.strictEqual(verdictMatch('对', '对'), true);
    assert.strictEqual(verdictMatch('部分对', '对'), false);
  });
  it('aggregate 通过率', () => {
    assert.deepStrictEqual(aggregate([true, true, false, true]), {
      total: 4,
      pass: 3,
      rate: 0.75,
    });
    assert.deepStrictEqual(aggregate([]), { total: 0, pass: 0, rate: 0 });
  });
});

describe('eval/runner.ts — 用 mock 模型验证聚合', () => {
  it('完美模型：不剧透 + 判分全对 → 100%', async () => {
    // mock：提示不含答案；判分回标准 JSON（按题干给"对"）
    const perfect = async (system: string, user: string) => {
      if (/判分官/.test(system)) {
        // 简单规则：含"防抖就是让函数少执行"→部分对；"网页关闭"→错；否则对
        if (/网页关闭/.test(user)) return '{"itemVerdicts":[{"index":0,"verdict":"错"}],"diagnosis":"x"}';
        if (/少执行几次/.test(user))
          return '{"itemVerdicts":[{"index":0,"verdict":"部分对"}],"diagnosis":"x"}';
        return '{"itemVerdicts":[{"index":0,"verdict":"对"}],"diagnosis":"x"}';
      }
      return '先从数据结构的角度想想该怎么降复杂度。';
    };
    const report = await runEval(perfect);
    assert.strictEqual(report.spoiler.rate, 1);
    assert.strictEqual(report.gradeAccuracy.rate, 1);
  });

  it('剧透模型：被指标抓到', async () => {
    const leaky = async (system: string) => {
      if (/判分官/.test(system)) return '{"itemVerdicts":[{"index":0,"verdict":"对"}]}';
      return '直接用哈希表，cur.next = prev 即可';
    };
    const report = await runEval(leaky);
    assert.ok(report.spoiler.rate < 1); // 至少一个被判剧透
  });
});
