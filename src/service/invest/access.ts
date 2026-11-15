import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { EntitlementService } from '../entitlement';
import { beijingDay } from '../../common/signupSite';

/**
 * 投资站的完整权限（2026-11-15 owner 拍板「关键数字收进会员」）。
 *
 * full＝会员 或 在 7 天完整体验期内。不在 full 的登录用户（免费版）：
 *  - 恐慌指数只看最近一个收盘值，盘中实时值不下发；
 *  - 四个指数只给所处区间（买入区/持有区/卖出区等），具体买入线、卖出线、长期中枢、
 *    收盘价相对中枢的距离都不下发；
 *  - 跟车页按非会员口径（原有逻辑）。
 *
 * 体验期：每位用户从第一次登录访问投资站那天起 7 个自然日（含当天）；方案上线前就来过的老用户
 * 从上线日起算。与「首个信号免费看全」是两件事，互不影响。
 */
export const FULL_TRIAL_LAUNCH = '20261116';
export const FULL_TRIAL_DAYS = 7;

/** YYYYMMDD 加 n 天（按日历日，不受时区影响）。 */
export function addDays(day: string, n: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 体验期最后一天（含）。firstDay 为空＝今天第一次来。 */
export function trialLastDay(firstDay: string | null, today: string): string {
  const first = firstDay || today;
  const anchor = first > FULL_TRIAL_LAUNCH ? first : FULL_TRIAL_LAUNCH;
  return addDays(anchor, FULL_TRIAL_DAYS - 1);
}

/** 体验期还剩几天（含今天；已过期为 0）。上线前（今天早于起算日）也按完整 7 天算。 */
export function trialDaysLeft(lastDay: string, today: string): number {
  if (today > lastDay) return 0;
  let n = 0;
  let d = today;
  while (d <= lastDay && n < 400) {
    n += 1;
    d = addDays(d, 1);
  }
  return Math.min(n, FULL_TRIAL_DAYS);
}

export interface InvestAccess {
  member: boolean;
  /** 会员或体验期内：看全部数字 */
  full: boolean;
  /** 体验期最后一天 YYYYMMDD（会员也给，前端不用） */
  trial_until: string | null;
  /** 体验期剩余天数（含今天）；会员为 null */
  trial_days_left: number | null;
}

/** 免费版的宽基读数：只留区间与市场级字段。 */
export function lockBroadRow(r: any) {
  return {
    trade_date: r.trade_date,
    leg: r.leg,
    etf: r.etf,
    state: r.state,
    fear: r.fear,
    data_date: r.data_date,
    locked: true,
  };
}

@Provide()
export class InvestAccessService {
  @Inject()
  db: InvestDbService;

  @Inject()
  entitlementService: EntitlementService;

  async state(userId: string, now = Date.now()): Promise<InvestAccess> {
    const today = beijingDay(now);
    let member = false;
    if (userId) {
      try {
        member = await this.entitlementService.isMember(userId);
      } catch {
        member = false;
      }
    }
    // 第一次来访日读不到时按「今天第一次来」处理：最多多给一次体验，不会误锁老会员以外的人太早
    let firstDay: string | null = null;
    try {
      const row = await this.db.one('SELECT MIN(day) d FROM user_site_activity WHERE user_id = ?', [userId]);
      firstDay = row?.d ? String(row.d) : null;
    } catch {
      firstDay = null;
    }
    const last = trialLastDay(firstDay, today);
    const left = trialDaysLeft(last, today);
    return {
      member,
      full: member || left > 0,
      trial_until: last,
      trial_days_left: member ? null : left,
    };
  }
}
