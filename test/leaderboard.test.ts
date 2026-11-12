import * as assert from 'assert';
import { beijingMonthStart, publicNickName } from '../src/common/leaderboard';

describe('排行榜工具', () => {
  it('昵称里的手机号 / 长串数字打码，普通昵称原样', () => {
    assert.strictEqual(publicNickName('13812345678'), '138******78');
    assert.strictEqual(publicNickName('小王13812345678'), '小王138******78');
    assert.strictEqual(publicNickName('前端小王2026'), '前端小王2026');
    assert.strictEqual(publicNickName(''), '匿名用户');
    assert.strictEqual(publicNickName(null), '匿名用户');
  });

  it('本月起点按北京时间算', () => {
    // 北京时间 12-01 07:00 = UTC 11-30 23:00，本月应是 12 月
    const d = beijingMonthStart(new Date('2026-11-30T23:00:00Z'));
    assert.strictEqual(d.toISOString(), '2026-11-30T16:00:00.000Z');
    const e = beijingMonthStart(new Date('2026-11-12T10:00:00Z'));
    assert.strictEqual(e.toISOString(), '2026-10-31T16:00:00.000Z');
  });
});
