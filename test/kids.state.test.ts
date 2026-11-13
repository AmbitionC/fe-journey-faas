import * as assert from 'assert';
import {
  MAX_DAYS,
  mergeProgress,
  mergeReading,
  readingKey,
  sanitizeReading,
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

describe('栗栗学英语 阅读状态同步', () => {
  const t0 = Date.UTC(2026, 10, 12, 8, 0, 0);

  it('丢掉不合法的书号、页码、时间戳', () => {
    const r = sanitizeReading({
      books: {
        'ort-l2-05': { page: 3, at: t0, done: [t0, t0, 'x', 123] },
        '../evil': { page: 1, at: t0 },
        'ort-l1-13': { page: -1, at: t0 },
        'ort-l3-01': { page: 2, at: 5 },
      },
      last: { id: 'ort-l2-05', page: 3, at: t0 },
      prefs: { autoNext: false, rate: 0.5, zh: true, ortLevel: 12, at: t0 },
    });
    assert.deepStrictEqual(Object.keys(r.books).sort(), ['ort-l1-13', 'ort-l2-05']);
    assert.deepStrictEqual(r.books['ort-l2-05'], { page: 3, at: t0, done: [t0] });
    assert.strictEqual(r.books['ort-l1-13'].page, 0);
    assert.deepStrictEqual(r.last, { id: 'ort-l2-05', page: 3, at: t0 });
    assert.deepStrictEqual(r.prefs, { autoNext: false, pagePause: 'medium', rate: 1, zh: true, ortLevel: 1, at: t0 });
    assert.deepStrictEqual(sanitizeReading('nope'), { books: {}, last: null, prefs: null });
  });

  it('两台设备合并：页码取新的，读完次数取并集不重复，偏好取新的', () => {
    const a = sanitizeReading({
      books: { 'ort-l2-05': { page: 3, at: t0, done: [t0] } },
      last: { id: 'ort-l2-05', page: 3, at: t0 },
      prefs: { autoNext: true, rate: 1, zh: true, ortLevel: 2, at: t0 },
    });
    const b = sanitizeReading({
      books: {
        'ort-l2-05': { page: 7, at: t0 + 1000, done: [t0, t0 + 900] },
        'ort-l2-06': { page: 1, at: t0 + 2000, done: [] },
      },
      last: { id: 'ort-l2-06', page: 1, at: t0 + 2000 },
      prefs: { autoNext: false, rate: 0.75, zh: false, ortLevel: 3, at: t0 - 1000 },
    });
    const m = mergeReading(a, b);
    assert.deepStrictEqual(m.books['ort-l2-05'], { page: 7, at: t0 + 1000, done: [t0, t0 + 900] });
    assert.strictEqual(m.books['ort-l2-06'].page, 1);
    assert.deepStrictEqual(m.last, { id: 'ort-l2-06', page: 1, at: t0 + 2000 });
    assert.strictEqual(m.prefs!.ortLevel, 2);
    assert.deepStrictEqual(mergeReading(m, m), m);
    assert.strictEqual(readingKey('u1'), 'kids:reading:u1');
  });
});

describe('栗栗学英语 计划级别', () => {
  const base = { nickname: '豆豆', ageBand: '3-4', minutesPerDay: 10, startDate: '2026-11-02', lockToPlan: false };
  it('级别 1-9 保留，其他丢掉', () => {
    assert.strictEqual(sanitizeProfile({ ...base, level: 3 })!.level, 3);
    for (const bad of [0, 10, 2.5, '3', null]) {
      assert.strictEqual('level' in sanitizeProfile({ ...base, level: bad })!, false, String(bad));
    }
  });
  it('翻页停顿只认 short / medium / long', () => {
    const t = Date.UTC(2026, 10, 12);
    const p = (pagePause: unknown) => sanitizeReading({ prefs: { pagePause, at: t } }).prefs!.pagePause;
    assert.strictEqual(p('long'), 'long');
    assert.strictEqual(p('slow'), 'medium');
  });
});
