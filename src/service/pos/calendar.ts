import { createHmac } from 'crypto';
import { dow, TimeBlock, TimeRule } from './time';

/**
 * 时间计划 → iCalendar 订阅（纯函数）。iPhone「日历」订阅这个地址后，作息模板里的计划段（副业 / 训练）
 * 和提前安排的事都会出现在系统日历里并提前 10 分钟提醒；模板改了，日历下次刷新自动跟着变。
 * 上班 / 睡觉这类推定段不进日历（只会把日历塞满）。
 */

const BYDAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const pad = (n: number) => String(n).padStart(2, '0');
const shift = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** 'YYYY-MM-DD' + 当天第几分钟（可 >1440）→ 'YYYYMMDDTHHMM00'（北京时间） */
const local = (date: string, min: number) => {
  const d = shift(date, Math.floor(min / 1440));
  const m = ((min % 1440) + 1440) % 1440;
  return `${d.replace(/-/g, '')}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
};
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** 订阅地址里的只读密钥：由访问令牌派生，泄露只暴露日程、不能写任何数据；换令牌即失效。 */
export function calendarKey(apiToken: string): string {
  return createHmac('sha256', apiToken).update('pos-calendar-v1').digest('hex').slice(0, 32);
}

const ALARM = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:提醒', 'TRIGGER:-PT10M', 'END:VALARM'];

export function buildIcs(rules: TimeRule[], blocks: TimeBlock[], today: string, stamp: string): string {
  const L: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Personal OS//time//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Personal OS',
    'X-WR-TIMEZONE:Asia/Shanghai',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  for (const r of rules) {
    if (r.kind !== 'template' || r.assume || r.startMin == null || r.endMin == null || !r.days.length) continue;
    // 第一次发生：从生效日（或今天往前一周）起第一个落在 days 里的日子
    const from = r.since && r.since > shift(today, -7) ? r.since : shift(today, -7);
    let first = from;
    for (let i = 0; i < 7 && !r.days.includes(dow(first)); i++) first = shift(first, 1);
    const end = r.endMin > r.startMin ? r.endMin : r.endMin + 1440;
    L.push(
      'BEGIN:VEVENT',
      `UID:rule-${r.key}@personal-os`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Shanghai:${local(first, r.startMin)}`,
      `DTEND;TZID=Asia/Shanghai:${local(first, end)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${r.days.map(d => BYDAY[d]).join(',')}`,
      `SUMMARY:${esc(r.title || r.category)}`,
      `CATEGORIES:${esc(r.category)}`,
      ...ALARM,
      'END:VEVENT'
    );
  }
  for (const b of blocks) {
    if (b.kind !== 'plan' || b.date < shift(today, -7)) continue;
    L.push(
      'BEGIN:VEVENT',
      `UID:block-${b.id ?? `${b.date}-${b.startMin}`}@personal-os`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Shanghai:${local(b.date, b.startMin)}`,
      `DTEND;TZID=Asia/Shanghai:${local(b.date, b.endMin)}`,
      `SUMMARY:${esc(b.title || b.category)}`,
      `CATEGORIES:${esc(b.category)}`,
      ...ALARM,
      'END:VEVENT'
    );
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}
