import * as assert from 'assert';
import {
  decideMockTrial,
  parseMockTrialState,
  MOCK_TRIAL_MAX_CALLS,
} from '../src/common/mockTrial';

describe('模拟面试免费体验：每人一场', () => {
  it('从没用过：放行并记下这场的 seed', () => {
    const r = decideMockTrial(null, 42, 1000);
    assert.strictEqual(r.allowed, true);
    assert.deepStrictEqual(r.next, { seed: 42, calls: 1, at: 1000 });
  });

  it('同一场接着答：放行并计数，到上限后拒绝', () => {
    let state = decideMockTrial(null, 7).next!;
    for (let i = 1; i < MOCK_TRIAL_MAX_CALLS; i++) {
      const r = decideMockTrial(state, 7);
      assert.strictEqual(r.allowed, true, `第 ${i + 1} 次应放行`);
      state = r.next!;
    }
    assert.strictEqual(decideMockTrial(state, 7).allowed, false);
  });

  it('换 seed 重开一场：拒绝', () => {
    const state = decideMockTrial(null, 7).next!;
    assert.strictEqual(decideMockTrial(state, 8).allowed, false);
  });

  it('这场已结束：同 seed 也拒绝', () => {
    const state = { ...decideMockTrial(null, 7).next!, finished: true };
    assert.strictEqual(decideMockTrial(state, 7).allowed, false);
  });

  it('坏数据按用过处理，不白送', () => {
    const s = parseMockTrialState('not json');
    assert.strictEqual(decideMockTrial(s, 1).allowed, false);
    assert.strictEqual(parseMockTrialState(null), null);
  });
});
