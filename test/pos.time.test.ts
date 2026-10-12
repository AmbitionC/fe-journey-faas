import * as assert from 'assert';
import { dayLedger, judgeTime, parseHHMM, planChecks, schedule, templateFor, TimeBlock, TimeRule, trainingBlocks, sleepBlocks, weekTime } from '../src/service/pos/time';

const T = (h: string) => parseHHMM(h);
let n = 0;
const rule = (p: Partial<TimeRule>): TimeRule => ({
  key: String(++n),
  kind: 'template',
  category: '其他',
  title: null,
  days: [1, 2, 3, 4, 5, 6, 7],
  startMin: null,
  endMin: null,
  assume: true,
  hoursPerWeek: null,
  ...p,
});
// 本人作息（2026-10-12 口述）：工作日 8:40–22:00 上班含通勤；周末陪娃，午睡与晚上睡后有空
const RULES: TimeRule[] = [
  rule({ category: '睡眠', startMin: T('23:30'), endMin: T('07:30') }),
  rule({ category: '主业', days: [1, 2, 3, 4, 5], startMin: T('08:40'), endMin: T('22:00') }),
  rule({ category: '副业', days: [1, 2, 3, 4], startMin: T('22:15'), endMin: T('23:15'), assume: false }),
  rule({ category: '家庭', days: [6, 7], startMin: T('08:00'), endMin: T('12:30') }),
  rule({ category: '副业', days: [6, 7], startMin: T('13:00'), endMin: T('15:00'), assume: false }),
  rule({ category: '家庭', days: [6, 7], startMin: T('15:00'), endMin: T('20:30') }),
  rule({ kind: 'budget', category: '副业', hoursPerWeek: 10 }),
];
const MON = '2026-10-05';
const blk = (date: string, s: string, e: string, category: string, kind: 'actual' | 'plan' = 'actual'): TimeBlock => {
  let end = T(e);
  if (end <= T(s)) end += 1440;
  return { date, startMin: T(s), endMin: end, category, title: null, kind };
};

describe('pos/time 时间账', () => {
  it('模板：周一含周日夜里跨过来的睡眠，上班、计划副业、当晚入睡', () => {
    const segs = templateFor(MON, RULES).map(x => [x.category, x.startMin, x.endMin, x.origin]);
    assert.deepStrictEqual(segs, [
      ['睡眠', 0, 450, 'template-assume'],
      ['主业', 520, 1320, 'template-assume'],
      ['副业', 1335, 1395, 'template-plan'],
      ['睡眠', 1410, 1440, 'template-assume'],
    ]);
  });

  it('没实报时只推定结构性时间，计划里的副业不算做了', () => {
    const l = dayLedger(MON, RULES, []);
    assert.deepStrictEqual(l.assumed, { 睡眠: 480, 主业: 800 });
    assert.deepStrictEqual(l.reported, {});
    assert.strictEqual(l.unrecorded, 160);
  });

  it('实报覆盖模板；计划被同类实报覆盖一半以上算做了', () => {
    const blocks = [blk(MON, '22:15', '23:15', '副业')];
    assert.strictEqual(dayLedger(MON, RULES, blocks).reported['副业'], 60);
    assert.strictEqual(planChecks(MON, RULES, blocks)[0].done, true);
    assert.strictEqual(planChecks('2026-10-06', RULES, blocks)[0].done, false);
    // 加班到 23:00 覆盖了模板里的主业结束段
    const ot = dayLedger(MON, RULES, [blk(MON, '22:00', '23:00', '主业')]);
    assert.strictEqual(ot.reported['主业'], 60);
    assert.strictEqual(ot.assumed['主业'], 800);
  });

  it('跨午夜的实报块分到两天', () => {
    const blocks = [blk(MON, '23:00', '01:00', '副业')];
    assert.strictEqual(dayLedger(MON, RULES, blocks).reported['副业'], 60);
    assert.strictEqual(dayLedger('2026-10-06', RULES, blocks).reported['副业'], 60);
  });

  it('一周账：副业按实报对预算，不够进重点；Watch 实测睡眠替换推定', () => {
    const blocks = [
      blk(MON, '22:15', '23:15', '副业'),
      blk('2026-10-07', '22:15', '23:15', '副业'),
      blk('2026-10-10', '13:00', '15:00', '副业'),
      blk('2026-10-11', '13:00', '15:00', '副业'),
    ];
    const w = weekTime(MON, '2026-10-12', RULES, blocks, [], { [MON]: 6.5 });
    const side = w.rows.find(r => r.category === '副业')!;
    assert.strictEqual(side.reportedHours, 6);
    assert.strictEqual(side.budget, 10);
    assert.strictEqual(side.planTotal, 6);
    assert.strictEqual(side.planDone, 4);
    assert.strictEqual(w.sleepMeasured, 6.5);
    assert.strictEqual(w.reportedDays, 4);
    const j = judgeTime(w);
    assert.deepStrictEqual(j.focus, ['副业：6/10 小时，计划 6 段做了 4 段']);
  });

  it('屏幕时间：周记录，社交娱乐日均 ≥ 2 小时进重点', () => {
    const w = weekTime(MON, '2026-10-12', RULES, [], [
      { period: 'week', start: MON, avgMin: 290, pickups: 98, categories: { 社交: 110, 娱乐: 40, 效率与财务: 60 }, apps: [{ name: '微信', min: 95 }] },
    ]);
    assert.strictEqual(w.screen!.social, 150);
    assert.ok(judgeTime(w).focus.includes('屏幕时间：社交娱乐日均 150 分钟'));
  });

  it('日程：今天起 7 天，计划段标做了没，预先安排的块也在', () => {
    const blocks = [blk('2026-10-13', '22:15', '23:15', '副业'), blk('2026-10-17', '09:00', '12:00', '家庭', 'plan')];
    const sc = schedule('2026-10-12', 7, '2026-10-13', RULES, blocks);
    assert.strictEqual(sc.length, 7);
    const tue = sc[1];
    assert.strictEqual(tue.isToday, true);
    assert.strictEqual(tue.segs.find(s => s.origin === 'template-plan')!.done, true);
    assert.ok(sc[5].segs.some(s => s.origin === 'plan' && s.start === '09:00'));
  });

  it('训练页记了组 = 当天中午训练段做了；没有计划段的日子按 12:00–12:45 记', () => {
    const rules = [
      ...RULES,
      rule({ category: '健康', title: '力量训练', days: [1, 3, 5], startMin: T('12:00'), endMin: T('12:45'), assume: false }),
    ];
    const tb = trainingBlocks([MON, MON, '2026-10-06'], rules);
    assert.strictEqual(tb.length, 2);
    assert.deepStrictEqual([tb[0].startMin, tb[0].endMin], [720, 765]);
    const checks = planChecks(MON, rules, tb).filter(c => c.category === '健康');
    assert.strictEqual(checks[0].done, true);
    // 中午训练的 45 分钟从推定的主业里扣出来，算实报的健康
    const l = dayLedger(MON, rules, tb);
    assert.strictEqual(l.reported['健康'], 45);
    assert.strictEqual(l.assumed['主业'], 800 - 45);
  });

  it('模板从建立那天起才生效：之前的日子不套计划、不对预算', () => {
    const rules = RULES.map(r => ({ ...r, since: '2026-10-12' }));
    assert.deepStrictEqual(templateFor('2026-10-11', rules), []);
    // 周一凌晨属于周日夜里那一段：周日还没有模板，也不推定
    assert.deepStrictEqual(templateFor('2026-10-12', rules).map(s => s.startMin)[0], 520);
    const w = weekTime('2026-10-05', '2026-10-12', rules, [], []);
    assert.deepStrictEqual(w.rows, []);
  });

  it('Watch 入睡/醒来 → 实报睡眠段，跨午夜分到两天', () => {
    const b = sleepBlocks([{ sleepStart: '2026-10-11 23:42', sleepEnd: '2026-10-12 07:15' }, { sleepStart: null, sleepEnd: null }]);
    assert.strictEqual(b.length, 1);
    assert.deepStrictEqual([b[0].date, b[0].startMin, b[0].endMin], ['2026-10-11', 1422, 1875]);
    assert.strictEqual(dayLedger('2026-10-12', RULES, b).reported['睡眠'], 435);
  });

  it('时间格式校验', () => {
    assert.strictEqual(parseHHMM('24:00'), 1440);
    assert.throws(() => parseHHMM('8点'));
    assert.throws(() => parseHHMM('25:00'));
  });
});
