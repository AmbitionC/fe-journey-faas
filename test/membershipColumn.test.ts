import * as assert from 'assert';
import { hasValidMemberColumn } from '../src/common/membership';

/**
 * 存量会员列的有效期判定（2026-09-13）。
 *
 * 背景：isMember 是个只增不减的裸标记，到期日只在 memberDate 里。此前
 * user.getUserById 只看前者、ai.ts 看两者，同一个过期用户拿到两套答案。
 * 判定统一到这里，这组用例钉住它。
 */
const fmtUtc = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

describe('hasValidMemberColumn', () => {
  it('标记为真且到期日在将来 → 有效', () => {
    const future = fmtUtc(new Date(Date.now() + 86400000));
    assert.strictEqual(hasValidMemberColumn(true, future), true);
  });

  it('标记为真但到期日已过 → 无效（这正是 9/9 之后那 84 行的状态）', () => {
    const past = fmtUtc(new Date(Date.now() - 86400000));
    assert.strictEqual(hasValidMemberColumn(true, past), false);
  });

  it('标记为假一律无效，哪怕到期日很远', () => {
    assert.strictEqual(hasValidMemberColumn(false, '2099-12-31 23:59:59'), false);
  });

  it('空 / 缺失 / 非法到期日按过期处理，不白送', () => {
    for (const bad of ['', '   ', 'not-a-date', '2026-13-45 99:99:99', null, undefined]) {
      assert.strictEqual(
        hasValidMemberColumn(true, bad as any),
        false,
        `memberDate=${JSON.stringify(bad)} 不该判为有效`
      );
    }
    assert.strictEqual(hasValidMemberColumn(undefined, undefined), false);
  });

  it('限免期下发的 2099 远期到期日仍然有效', () => {
    assert.strictEqual(hasValidMemberColumn(true, '2099-12-31 23:59:59'), true);
  });

  it('无时区的值按 UTC 解析（写入侧是 toISOString，不能按本地时区读）', () => {
    // 取一个「UTC 已过期、但东八区本地时间看还没到」的时刻：
    // 现在往前推 4 小时。按 UTC 读＝已过期；若误按 UTC+8 读会晚 8 小时、判成有效。
    const fourHoursAgo = fmtUtc(new Date(Date.now() - 4 * 3600 * 1000));
    assert.strictEqual(
      hasValidMemberColumn(true, fourHoursAgo),
      false,
      '按本地时区解析会把已过期的会员判成有效'
    );
  });

  it('带时区标记的值按其自身时区解析', () => {
    const futureZ = new Date(Date.now() + 86400000).toISOString(); // 末尾带 Z
    assert.strictEqual(hasValidMemberColumn(true, futureZ), true);
    const pastZ = new Date(Date.now() - 86400000).toISOString();
    assert.strictEqual(hasValidMemberColumn(true, pastZ), false);
  });

  it('边界：到期日恰为当前时刻 → 无效（严格大于）', () => {
    const now = new Date();
    // 截到秒后一定 <= 现在，因此必须判无效
    assert.strictEqual(hasValidMemberColumn(true, fmtUtc(now)), false);
  });
});
