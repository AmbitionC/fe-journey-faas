import * as assert from 'assert';
import { buildIcs, calendarKey } from '../src/service/pos/calendar';
import { TimeRule } from '../src/service/pos/time';

const rule = (p: Partial<TimeRule>): TimeRule => ({
  key: 'x', kind: 'template', category: '副业', title: null, days: [], startMin: null, endMin: null, assume: false, hoursPerWeek: null, ...p,
});

describe('pos/calendar 日历订阅', () => {
  const rules = [
    rule({ key: '1', category: '主业', days: [1, 2, 3, 4, 5], startMin: 520, endMin: 1335, assume: true }),
    rule({ key: '2', category: '健康', title: '力量训练（公司健身房）', days: [1, 3, 5], startMin: 720, endMin: 765, since: '2026-10-12' }),
    rule({ key: '3', title: '副业, 写课程', days: [3], startMin: 1365, endMin: 1425, since: '2026-10-12' }),
  ];
  const ics = buildIcs(
    rules,
    [{ id: 9, date: '2026-10-17', startMin: 540, endMin: 720, category: '家庭', title: '带娃去公园', kind: 'plan' }],
    '2026-10-12',
    '20261012T050000Z'
  );

  it('只放计划段与提前安排，不放上班这类推定段', () => {
    assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
    assert.ok(!ics.includes('UID:rule-1@'));
  });

  it('模板按周重复、北京时间、提前 10 分钟提醒，文本转义', () => {
    assert.ok(ics.includes('DTSTART;TZID=Asia/Shanghai:20261012T120000'));
    assert.ok(ics.includes('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'));
    assert.ok(ics.includes('DTSTART;TZID=Asia/Shanghai:20261014T224500'));
    assert.ok(ics.includes('SUMMARY:副业\\, 写课程'));
    assert.ok(ics.includes('TRIGGER:-PT10M'));
    assert.ok(ics.includes('DTSTART;TZID=Asia/Shanghai:20261017T090000'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n') && ics.includes('\r\n'));
  });

  it('跨午夜的段结束在次日', () => {
    const x = buildIcs([rule({ key: '4', days: [6], startMin: 1380, endMin: 60, since: '2026-10-12' })], [], '2026-10-12', 'S');
    assert.ok(x.includes('DTSTART;TZID=Asia/Shanghai:20261017T230000'));
    assert.ok(x.includes('DTEND;TZID=Asia/Shanghai:20261018T010000'));
  });

  it('订阅密钥由令牌派生、稳定、不等于令牌', () => {
    assert.strictEqual(calendarKey('t1'), calendarKey('t1'));
    assert.notStrictEqual(calendarKey('t1'), calendarKey('t2'));
    assert.strictEqual(calendarKey('t1').length, 32);
  });
});
