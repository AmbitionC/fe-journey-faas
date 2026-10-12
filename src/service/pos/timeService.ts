import { Provide, Inject } from '@midwayjs/core';
import { PosDbService } from './db';
import { HealthActivityService } from '../health/activity';
import { todayCN } from './logic';
import { CATEGORIES, ScreenRecord, TimeBlock, TimeRule, parseHHMM, schedule, trainingBlocks, weekTime } from './time';
import { HealthTrainingService } from '../health/training/service';
import { weekStartOf } from './review';

const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDate = (s: any): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const toDate = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const parseJson = <T>(s: any, d: T): T => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

/**
 * 时间：预算 + 作息模板（pos_time_rule）、实报与预先安排（pos_time_block）、屏幕使用时间（pos_screen_time）。
 * 规则与模板走对话同步（invest-model personal/data/time*.json），网站上可补记实报段、一键确认计划做了。
 */
@Provide()
export class PosTimeService {
  @Inject()
  db: PosDbService;

  @Inject()
  activityService: HealthActivityService;

  @Inject()
  trainingService: HealthTrainingService;

  /** 实报块 + 训练记录换算的块（训练页记了组 = 当天训练段做了）。 */
  private async withTraining(blocks: TimeBlock[], rules: TimeRule[], from: string, to: string): Promise<TimeBlock[]> {
    const dates = await this.trainingService.trainedDates(Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1), to).catch(() => []);
    // 当天已经手动记过健康段的不重复加
    const manual = new Set(blocks.filter(b => b.kind === 'actual' && b.category === '健康').map(b => b.date));
    return [...blocks, ...trainingBlocks(dates.filter(d => d >= from && !manual.has(d)), rules)];
  }

  async rules(): Promise<TimeRule[]> {
    const rows = await this.db.q<any>('SELECT * FROM pos_time_rule ORDER BY kind, start_min, id');
    return rows.map(r => ({
      key: String(r.id),
      kind: r.kind,
      category: r.category,
      title: r.title,
      days: String(r.days || '')
        .split(',')
        .filter(Boolean)
        .map(Number),
      startMin: r.start_min == null ? null : Number(r.start_min),
      endMin: r.end_min == null ? null : Number(r.end_min),
      assume: Number(r.assume) === 1,
      hoursPerWeek: r.hours_per_week == null ? null : Number(r.hours_per_week),
    }));
  }

  async blocks(from: string, to: string): Promise<TimeBlock[]> {
    // 多取前一天：跨午夜的块会延续到 from 当天
    const rows = await this.db.q<any>('SELECT * FROM pos_time_block WHERE block_date BETWEEN ? AND ? ORDER BY block_date, start_min', [
      shift(from, -1),
      to,
    ]);
    return rows.map(r => ({
      id: Number(r.id),
      date: toDate(r.block_date),
      startMin: Number(r.start_min),
      endMin: Number(r.end_min),
      category: r.category,
      title: r.title,
      kind: r.kind,
      source: r.source,
    }));
  }

  async screen(from: string, to: string): Promise<ScreenRecord[]> {
    const rows = await this.db.q<any>('SELECT * FROM pos_screen_time WHERE start_date BETWEEN ? AND ? ORDER BY start_date', [from, to]);
    return rows.map(r => ({
      period: r.period,
      start: toDate(r.start_date),
      avgMin: Number(r.avg_min),
      pickups: r.pickups == null ? null : Number(r.pickups),
      categories: parseJson(r.categories_json, {}),
      apps: parseJson(r.apps_json, []),
    }));
  }

  private async sleepByDate(from: string, to: string): Promise<Record<string, number>> {
    const acts = await this.activityService.list(Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 14)).catch(() => []);
    return Object.fromEntries(acts.filter(a => a.date >= from && a.date <= to && a.sleepHours).map(a => [a.date, a.sleepHours as number]));
  }

  /** 某周时间账（默认本周至今）。 */
  async week(weekStart?: string, today = todayCN()) {
    const ws = isDate(weekStart) ? weekStartOf(weekStart) : weekStartOf(today);
    const we = shift(ws, 6);
    const [rules, raw, screen, sleep] = await Promise.all([
      this.rules(),
      this.blocks(ws, we),
      this.screen(ws, we),
      this.sleepByDate(ws, we),
    ]);
    const blocks = await this.withTraining(raw, rules, ws, we);
    return weekTime(ws, today, rules, blocks, screen, sleep);
  }

  /** 首页 / 时间页：本周账 + 上周账 + 今天起 7 天日程 + 最近一次屏幕时间。 */
  async overview(today = todayCN()) {
    const ws = weekStartOf(today);
    const [rules, raw, screen, sleep] = await Promise.all([
      this.rules(),
      this.blocks(shift(ws, -7), shift(today, 7)),
      this.screen(shift(ws, -35), shift(today, 7)),
      this.sleepByDate(shift(ws, -7), today),
    ]);
    const blocks = await this.withTraining(raw, rules, shift(ws, -7), today);
    const lastScreen = [...screen].sort((a, b) => b.start.localeCompare(a.start))[0] || null;
    return {
      today,
      thisWeek: weekTime(ws, today, rules, blocks, screen, sleep),
      lastWeek: weekTime(shift(ws, -7), today, rules, blocks, screen, sleep),
      schedule: schedule(today, 7, today, rules, blocks),
      budgets: rules.filter(r => r.kind === 'budget').map(r => ({ category: r.category, hoursPerWeek: r.hoursPerWeek })),
      hasTemplate: rules.some(r => r.kind === 'template'),
      screenLatest: lastScreen,
      screenTrend: screen.filter(s => s.period === 'week').map(s => ({ start: s.start, avgMin: s.avgMin })),
      categories: CATEGORIES,
    };
  }

  /** 网站补记一段（实报或预先安排）。 */
  async addBlock(p: { date?: string; start: string; end: string; category: string; title?: string; kind?: 'actual' | 'plan' }) {
    const date = isDate(p.date) ? p.date : todayCN();
    if (!(CATEGORIES as readonly string[]).includes(p.category)) throw new Error(`分类只能是：${CATEGORIES.join(' / ')}`);
    const s = parseHHMM(p.start);
    let e = parseHHMM(p.end);
    if (e <= s) e += 1440; // 跨午夜
    if (e - s > 24 * 60) throw new Error('一段不能超过 24 小时');
    const kind = p.kind === 'plan' ? 'plan' : 'actual';
    await this.db.exec(
      `INSERT INTO pos_time_block (block_date, start_min, end_min, category, title, kind, source) VALUES (?, ?, ?, ?, ?, ?, 'web')`,
      [date, s, e, p.category, (p.title || '').slice(0, 100) || null, kind]
    );
    return this.overview();
  }

  /** 计划段一键确认「做了」：按计划时段记一条实报。 */
  async confirm(p: { date: string; startMin: number; endMin: number; category: string; title?: string | null }) {
    if (!isDate(p.date)) throw new Error('date 需为 YYYY-MM-DD');
    if (!(CATEGORIES as readonly string[]).includes(p.category)) throw new Error('分类不合法');
    await this.db.exec(
      `INSERT INTO pos_time_block (block_date, start_min, end_min, category, title, kind, source) VALUES (?, ?, ?, ?, ?, 'actual', 'web')`,
      [p.date, Number(p.startMin), Number(p.endMin), p.category, p.title || null]
    );
    return this.overview();
  }

  /** 只能删网站记的块（对话同步的由文件管理）。 */
  async removeBlock(id: number) {
    await this.db.exec(`DELETE FROM pos_time_block WHERE id = ? AND source = 'web'`, [id]);
    return this.overview();
  }
}
