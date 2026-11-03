import * as assert from 'assert';
import { decideReading, READING_QUOTA } from '../src/common/readingQuota';

describe('非会员阅读额度判定', () => {
  it('额度是游客 3、登录 5（owner 2026-11-03 定）', () => {
    assert.deepStrictEqual({ ...READING_QUOTA }, { guest: 3, login: 5 });
  });
  it('没看满可以看新的，并占一个额度', () => {
    const d = decideReading(new Set(['a', 'b']), 'c', 5);
    assert.deepStrictEqual(d, { allowed: true, used: 3, quota: 5, consumes: true });
  });
  it('看满后新文章被拦，已用篇数不变', () => {
    const d = decideReading(new Set(['a', 'b', 'c', 'd', 'e']), 'f', 5);
    assert.deepStrictEqual(d, { allowed: false, used: 5, quota: 5, consumes: false });
  });
  it('看过的随时能重看，不再占额度', () => {
    const d = decideReading(new Set(['a', 'b', 'c', 'd', 'e']), 'c', 5);
    assert.deepStrictEqual(d, { allowed: true, used: 5, quota: 5, consumes: false });
  });
});
