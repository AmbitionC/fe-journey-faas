import * as assert from 'assert';
import { parseSleepSamples } from '../src/service/health/sleep';

describe('health/sleep 睡眠样本', () => {
  it('去掉在床上/清醒，iPhone 与 Watch 重复段取并集', () => {
    const text = [
      '2026-10-11 23:20|2026-10-12 07:40|在床上',
      '2026-10-11 23:42|2026-10-12 01:05|核心睡眠',
      '2026-10-12 01:05|2026-10-12 01:50|深度睡眠',
      '2026-10-12 01:50|2026-10-12 02:10|清醒',
      '2026-10-12 02:10|2026-10-12 07:15|核心睡眠',
      '2026-10-12 02:30|2026-10-12 06:00|睡眠中', // iPhone 重复记的
    ].join('\n');
    const n = parseSleepSamples(text, '2026-10-12')!;
    assert.strictEqual(n.start, '2026-10-11 23:42');
    assert.strictEqual(n.end, '2026-10-12 07:15');
    assert.strictEqual(n.hours, 7.22); // 2h08 + 5h05 = 7h13
    assert.strictEqual(n.segments, 2);
  });

  it('只算当天醒来的那一觉；接受数组、ISO 带时区、中文日期格式', () => {
    const n = parseSleepSamples(
      [
        { start: '2026-10-10T23:30:00+08:00', end: '2026-10-11T07:00:00+08:00', value: 'Core' }, // 前一晚，不算
        { start: '2026-10-11T15:40:00Z', end: '2026-10-11T22:50:00Z', value: 'Asleep' }, // 北京 23:40 → 06:50
        { start: '2026年10月12日 13:00', end: '2026年10月12日 13:40', value: '核心睡眠' }, // 午睡，在窗口内
      ],
      '2026-10-12'
    )!;
    assert.strictEqual(n.start, '2026-10-11 23:40');
    assert.strictEqual(n.end, '2026-10-12 13:40');
    assert.strictEqual(n.hours, 7.83);
  });

  it('分号分隔也行（快捷指令拼 JSON 时用）', () => {
    const n = parseSleepSamples('2026-10-11 23:42|2026-10-12 02:10|核心睡眠;2026-10-12 02:10|2026-10-12 07:15|深度睡眠', '2026-10-12')!;
    assert.strictEqual(n.hours, 7.55);
  });

  it('没有睡着的样本返回 null', () => {
    assert.strictEqual(parseSleepSamples('2026-10-11 23:20|2026-10-12 07:40|在床上', '2026-10-12'), null);
    assert.strictEqual(parseSleepSamples('', '2026-10-12'), null);
  });
});
