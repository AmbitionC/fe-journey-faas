import * as assert from 'assert';
import {
  MAX_DAYS,
  mergeProgress,
  sanitizeProfile,
  sanitizeProgress,
} from '../src/service/kids/state';

describe('栗栗学英语 计划/进度', () => {
  const profile = {
    nickname: '豆豆',
    ageBand: '3-4',
    minutesPerDay: 10,
    startDate: '2026-11-01',
    lockToPlan: true,
  };

  it('合法计划原样保留，多余字段丢掉', () => {
    assert.deepStrictEqual(sanitizeProfile({ ...profile, userId: 'x' }), profile);
  });

  it('昵称为空、年龄段或时长不认识时拒绝', () => {
    assert.strictEqual(sanitizeProfile({ ...profile, nickname: '  ' }), null);
    assert.strictEqual(sanitizeProfile({ ...profile, ageBand: '7-8' }), null);
    assert.strictEqual(sanitizeProfile({ ...profile, minutesPerDay: 60 }), null);
    assert.strictEqual(sanitizeProfile({ ...profile, startDate: '明天' }), null);
    assert.strictEqual(sanitizeProfile(null), null);
  });

  it('昵称截到 12 个字', () => {
    assert.strictEqual(sanitizeProfile({ ...profile, nickname: '一二三四五六七八九十一二三四' })!.nickname.length, 12);
  });

  it('进度丢掉坏日期和坏书号、去重', () => {
    const p = sanitizeProgress({
      '2026-11-01': { done: ['s02', 's02', '../etc'], words: ['help', 'help'] },
      bad: { done: ['s04'] },
      '2026-11-02': { done: [], words: [] },
    });
    assert.deepStrictEqual(p, { '2026-11-01': { done: ['s02'], words: ['help'] } });
  });

  it('进度最多留最近 MAX_DAYS 天', () => {
    const raw: Record<string, any> = {};
    const start = Date.UTC(2024, 0, 1);
    for (let i = 0; i < MAX_DAYS + 5; i++) {
      raw[new Date(start + i * 864e5).toISOString().slice(0, 10)] = { done: ['s02'], words: [] };
    }
    const p = sanitizeProgress(raw);
    assert.strictEqual(Object.keys(p).length, MAX_DAYS);
    assert.ok(!p['2024-01-01']);
  });

  it('两台设备的进度取并集', () => {
    const merged = mergeProgress(
      { '2026-11-01': { done: ['s02'], words: ['help'] } },
      {
        '2026-11-01': { done: ['s04'], words: ['help', 'brave'] },
        '2026-11-02': { done: ['s05'], words: [] },
      },
    );
    assert.deepStrictEqual(merged, {
      '2026-11-01': { done: ['s02', 's04'], words: ['help', 'brave'] },
      '2026-11-02': { done: ['s05'], words: [] },
    });
  });
});
