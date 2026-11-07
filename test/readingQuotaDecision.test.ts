import * as assert from 'assert';
import { beijingDate, decideReading, QUOTA_MODULES, READING_QUOTA } from '../src/common/readingQuota';

describe('非会员阅读额度判定', () => {
  it('额度是游客 3、登录 5（owner 2026-11-03 定）', () => {
    assert.deepStrictEqual({ ...READING_QUOTA }, { guest: 3, login: 5 });
  });
  it('面经、知识点、算法题、央国企备考库各自计数（owner 2026-11-03 算法题也纳入）', () => {
    assert.deepStrictEqual([...QUOTA_MODULES], ['interview', 'knowledge', 'algorithm', 'soe']);
  });
  it('没看满可以看新的，并占一个额度', () => {
    const d = decideReading(new Set(['a', 'b']), new Set(['a', 'b']), 'c', 5);
    assert.deepStrictEqual(d, { allowed: true, used: 3, quota: 5, consumes: true });
  });
  it('看满后新文章被拦，已用篇数不变', () => {
    const d = decideReading(new Set(['a', 'b', 'c', 'd', 'e']), new Set(['a', 'b', 'c', 'd', 'e']), 'f', 5);
    assert.deepStrictEqual(d, { allowed: false, used: 5, quota: 5, consumes: false });
  });
  it('看过的随时能重看，不再占额度', () => {
    const d = decideReading(new Set(['a', 'b', 'c', 'd', 'e']), new Set(['a', 'b', 'c', 'd', 'e']), 'c', 5);
    assert.deepStrictEqual(d, { allowed: true, used: 5, quota: 5, consumes: false });
  });
  it('额度按天：以前看过的不占今天额度，今天新看满 5 篇才拦', () => {
    const ever = new Set(['old1', 'old2', 'old3', 'old4', 'old5', 'old6']);
    // 昨天及更早看了 6 篇，今天一篇没看：新文章照样放行
    assert.deepStrictEqual(decideReading(ever, new Set(), 'new', 5), {
      allowed: true, used: 1, quota: 5, consumes: true,
    });
    // 以前看过的重看：放行、不占额度
    assert.deepStrictEqual(decideReading(ever, new Set(), 'old1', 5), {
      allowed: true, used: 0, quota: 5, consumes: false,
    });
    // 今天已新看 5 篇：第 6 篇新的被拦，以前的照样能看
    const today = new Set(['t1', 't2', 't3', 't4', 't5']);
    const all = new Set([...ever, ...today]);
    assert.strictEqual(decideReading(all, today, 't6', 5).allowed, false);
    assert.strictEqual(decideReading(all, today, 'old3', 5).allowed, true);
  });
  it('按北京时间零点换日', () => {
    assert.strictEqual(beijingDate(new Date('2026-11-03T15:59:00Z')), '2026-11-03');
    assert.strictEqual(beijingDate(new Date('2026-11-03T16:00:00Z')), '2026-11-04');
  });
});
