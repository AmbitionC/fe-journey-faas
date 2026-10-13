import * as assert from 'assert';
import { parseVitals, readings, vitalSummary, weightKg } from '../src/service/health/vitals';

import { cnWallToIso } from '../src/service/health/activity';

describe('health/activity 库内时间', () => {
  it('updated_at 是北京时间墙上时间：字符串与驱动按本地时区解析出的 Date 都还原成真实时刻', () => {
    assert.strictEqual(cnWallToIso('2026-10-13 12:54:18'), '2026-10-13T04:54:18.000Z');
    // 驱动按实例本地时区把墙上时间解析成 Date；无论实例在哪个时区，本地字段都等于墙上时间
    assert.strictEqual(cnWallToIso(new Date(2026, 9, 12, 23, 50, 13)), '2026-10-12T15:50:13.000Z');
    assert.strictEqual(cnWallToIso(null), null);
  });
});

describe('health/vitals 健康 App 样本解析', () => {
  it('样本文本带单位、多行、千分位都能读出数', () => {
    assert.deepStrictEqual(readings('58 次/分\n61 次/分').map(r => r.value), [58, 61]);
    assert.deepStrictEqual(readings('1,234.5 米').map(r => r.value), [1234.5]);
    assert.deepStrictEqual(readings([42, '45.5 毫秒']).map(r => r.value), [42, 45.5]);
    assert.deepStrictEqual(readings(''), []);
  });

  it('按指标聚合：静息心率取第一条、HRV 取均值、距离求和并换算成公里、血氧小数转百分比', () => {
    const v = parseVitals({
      resting_hr: '58 次/分\n63 次/分',
      hrv: '40 毫秒\n50 毫秒\n60 毫秒',
      distance: '800 米\n1.2 公里',
      spo2: '0.97\n0.95',
      resp_rate: '15 次/分',
      vo2max: '33.4 mL/(kg·min)',
      body_fat: '28%',
    });
    assert.deepStrictEqual(v, { restingHr: 58, hrvMs: 50, vo2max: 33.4, spo2Pct: 96, respRate: 15, distanceKm: 2, bodyFatPct: 28 });
  });

  it('越界样本丢掉；全丢光就不写这项', () => {
    assert.deepStrictEqual(parseVitals({ resting_hr: '0 次/分', hrv: 'abc' }), {});
  });

  it('体重：公斤 / 斤 / 磅', () => {
    assert.strictEqual(weightKg('92.2 公斤'), 92.2);
    assert.strictEqual(weightKg('184.4 斤'), 92.2);
    assert.strictEqual(weightKg('203 lb'), 92.08);
    assert.strictEqual(weightKg(92.2), 92.2);
    assert.strictEqual(weightKg('5 公斤'), null);
  });

  it('首页摘要：最近值 + 近 7 天均值', () => {
    const s = vitalSummary(
      [
        { date: '2026-10-01', restingHr: 70 },
        { date: '2026-10-10', restingHr: 60 },
        { date: '2026-10-12', restingHr: 58, hrvMs: 41.2 },
      ],
      '2026-10-12'
    );
    assert.deepStrictEqual(s.restingHr, { value: 58, date: '2026-10-12', avg7: 59, days7: 2 });
    assert.strictEqual(s.hrvMs.avg7, 41.2);
    assert.ok(!('vo2max' in s));
  });
});
