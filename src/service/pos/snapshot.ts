import { Provide, Inject } from '@midwayjs/core';
import { PosDashboardService } from './dashboard';
import { PosFinanceService } from './finance';
import { PosContextService } from './context';
import { PosTimeService } from './timeService';
import { PosReviewService } from './reviewService';
import { PosDbService } from './db';
import { HealthProfileService } from '../health/profile';
import { HealthActivityService } from '../health/activity';
import { HealthBodyService } from '../health/body';
import { HealthTrainingService } from '../health/training/service';
import { todayCN } from './logic';

/**
 * 给任何 Agent 用的「全量个人快照」（GET /pos/snapshot）：一次请求拿到画像、健康、财富、收入、消费、时间、复盘，
 * 外加 guide（数据在哪、口径是什么、怎么写回）。只读、单块失败不拖垮整份（该块变成 { error }）。
 */

export interface TxnRow {
  txn_time: string | Date;
  kind: string;
  category: string;
  counterparty: string | null;
  net: number | string;
}

const r0 = (x: number) => Math.round(x);
const ym = (t: string | Date) => (t instanceof Date ? t.toISOString() : String(t)).slice(0, 7);

/** 账单流水 → 消费摘要（纯函数）：只有 kind=consume 算花费，其余按 kind 单列。 */
export function spendingSummary(rows: TxnRow[]) {
  const consume = rows.filter(r => r.kind === 'consume');
  const sum = (xs: TxnRow[]) => xs.reduce((s, r) => s + Number(r.net), 0);
  const group = <K extends string>(xs: TxnRow[], key: (r: TxnRow) => K) => {
    const m = new Map<K, TxnRow[]>();
    for (const r of xs) m.set(key(r), [...(m.get(key(r)) || []), r]);
    return [...m.entries()];
  };
  const months = group(consume, r => ym(r.txn_time))
    .map(([month, xs]) => ({ month, total: r0(sum(xs)), count: xs.length }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const total = sum(consume);
  const byCategory = group(consume, r => r.category)
    .map(([category, xs]) => ({ category, total: r0(sum(xs)), count: xs.length, share: total ? Math.round((sum(xs) / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.total - a.total);
  const topMerchants = group(consume, r => r.counterparty || '（未知）')
    .map(([merchant, xs]) => ({ merchant, total: r0(sum(xs)), count: xs.length }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
  const nonConsume = group(rows.filter(r => r.kind !== 'consume' && r.kind !== 'dup' && r.kind !== 'void'), r => `${r.kind}:${r.category}`)
    .map(([k, xs]) => ({ kind: k.split(':')[0], category: k.slice(k.indexOf(':') + 1), total: r0(sum(xs)), count: xs.length }))
    .sort((a, b) => b.total - a.total);
  const times = rows.map(r => (r.txn_time instanceof Date ? r.txn_time.toISOString() : String(r.txn_time)).slice(0, 10)).sort();
  return {
    window: times.length ? { from: times[0], to: times[times.length - 1] } : null,
    consumeTotal: r0(total),
    monthlyAvg: months.length ? r0(total / months.length) : null,
    months,
    byCategory,
    topMerchants,
    nonConsume,
  };
}

const GUIDE = {
  what: '陈昊的个人数据快照（Personal OS）。健康、财富、收入、消费、时间、目标的全量当前状态；数字都带日期，缺的就是没有，不要臆造。',
  owner: '1995 年生，杭州，阿里巴巴研发工程师；已婚，一个女儿；重度脂肪肝在减脂；财务重心在副业。细节见 about.facts。',
  conventions: [
    '金额单位人民币元（USD 账户另标）；日期北京时间 YYYY-MM-DD。',
    'factType：measured 实测 / imported 导入 / reported 自述 / estimated 估算 / derived 派生。',
    '净资产不含自住房（本人定：只自住不卖，不计入资产），房贷等照计负债。',
    'spending 只统计 kind=consume；family（转给家人）/ gift / p2p / invest / internal / debt（补房贷）/ cash（取现）单列在 nonConsume；dup 是银行流水里已在支付宝微信记过的同一笔。',
    '饮食热量是拍照估算（±20%）；Watch 数据经 iOS 快捷指令每天 9:00/14:00/17:00/23:50 推送，23:00 后那次算当天收盘值，白天的是盘中值（health.summary.today.watch 为盘中推算）。',
  ],
  readMore: {
    api: 'fe-journey-faas：GET /pos/dashboard、/pos/wealth、/pos/time、/pos/review/weekly、/pos/profile、/health/*（请求头 X-Health-Token）',
    rawFiles: 'GitHub 私有仓 AmbitionC/invest-model 的 personal/data/*.json（账户/收入/事件/关于我/作息…）与 personal/data/txn/*.csv（支付宝/微信/招行逐笔流水，raw_json 保留导出原文）',
    rules: 'AmbitionC/health-journey 的 CLAUDE.md 与 docs/personal-os/*（各类数据怎么采集、口径、预警与复盘规则）',
  },
  writeBack: [
    '个人数据（余额、收入、体成分、目标、关于我、作息、时间段、屏幕时间、账单）：改 invest-model personal/data/ 下对应文件并 push master，personal-data workflow 约 1 分钟写库（声明式对账，文件即完整清单）。',
    '餐食：invest-model personal/meals/YYYY-MM-DD/HHMM-<餐次>.json，push 触发 personal-meals。',
    '规则/阈值/计划：改 fe-journey-faas 源码（alerts.ts、review.ts、time.ts、training/plan.ts）并补测试，push master 自动部署。',
  ],
};

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e: any) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

@Provide()
export class PosSnapshotService {
  @Inject()
  dashboardService: PosDashboardService;

  @Inject()
  finance: PosFinanceService;

  @Inject()
  context: PosContextService;

  @Inject()
  timeService: PosTimeService;

  @Inject()
  reviewService: PosReviewService;

  @Inject()
  db: PosDbService;

  @Inject()
  profileService: HealthProfileService;

  @Inject()
  activityService: HealthActivityService;

  @Inject()
  bodyService: HealthBodyService;

  @Inject()
  trainingService: HealthTrainingService;

  async build() {
    const today = todayCN();
    const [health, career, wealth, facts, goals, events, incomes, profile, activity, body, training, time, reviews, txn] =
      await Promise.all([
        safe(() => this.dashboardService.health(today)),
        safe(() => this.dashboardService.career()),
        safe(() => this.finance.wealth()),
        safe(() => this.context.facts()),
        safe(() => this.context.goals()),
        safe(() => this.context.events({ limit: 200 })),
        safe(() => this.finance.incomes(24)),
        safe(() => this.profileService.get()),
        safe(() => this.activityService.list(30)),
        safe(() => this.bodyService.trend(365)),
        safe(() => this.trainingService.today()),
        safe(() => this.timeService.overview(today)),
        safe(() => this.reviewService.list(4)),
        safe(() =>
          this.db.q<TxnRow>(
            'SELECT txn_time, kind, category, counterparty, net FROM pos_txn WHERE txn_time >= DATE_SUB(CURDATE(), INTERVAL 13 MONTH)'
          )
        ),
      ]);
    const strip = (h: any) => {
      if (!h || h.error) return h;
      // 首页用的长序列对 Agent 没用，留摘要
      const { weightSeries, kcalSeries, ...rest } = h;
      return { ...rest, weightSeries: (weightSeries || []).slice(-30) };
    };
    const rv: any = reviews;
    return {
      generatedAt: new Date().toISOString(),
      today,
      guide: GUIDE,
      about: { facts, goals, healthProfile: profile },
      health: {
        summary: strip(health),
        body,
        activity30: activity,
        training,
      },
      wealth,
      career,
      incomes,
      events,
      spending: Array.isArray(txn) ? spendingSummary(txn) : txn,
      time,
      reviews: rv && !rv.error ? { current: rv.current, history: rv.history } : rv,
    };
  }
}
