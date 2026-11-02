import { Provide, Inject, Config, Scope, ScopeEnum } from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { TypeORMDataSourceManager } from '@midwayjs/typeorm';
import { R } from '../../common/base.error.utils';
import { isMembershipFree, MembershipConfig } from '../../common/membership';
import {
  BillingStore,
  IrisMode,
  IRIS_COST,
  IRIS_DAILY_CAP,
  IRIS_FREE_DAILY,
  IRIS_GUEST_DAILY,
  IRIS_MEMBER_ONLY,
  MEMBER_MONTHLY_POINTS,
  REFERRAL_REWARD,
  TRIAL_POINTS,
  irisCost,
  irisLedgerRef,
} from '../../mcp/billing';
import { Analytics } from '../../mcp/analytics';

/**
 * Iris 计点（owner 2026-11-02：「Iris 的调用也应该算到 credit，会员提供一定额度的 credit」）。
 *
 * 一次 Iris 调用 = 一次 `begin()`：
 * - 限免期（membership.freeUntil / freeForAll）→ 不计不扣，与改版前行为一致（应急回滚开关）；
 * - 游客（userId 形如 `guest:<ip>`）→ 只能用普通问答，每天 IRIS_GUEST_DAILY 次，不进点数账户；
 * - 登录用户 → 会员专享模式先验资格；每天总调用数有上限（成本保险丝）；普通问答每天前
 *   IRIS_FREE_DAILY 次免费；其余按 IRIS_COST 从 mcp_account 原子扣点（与 Skill 共用余额与流水，
 *   复用 BillingStore.charge / refund），账户不存在时顺手开通并送体验点（activate 幂等）。
 *
 * 错误文案带前缀，前端据此分流：`RATE_LIMIT:`（免费次数/上限用完）、`CREDIT_EXHAUSTED:`（点数不足）、
 * `MEMBER_ONLY:`（会员专享）。前缀是协议的一部分，别改。
 *
 * 为什么不是 Redis 计数：Redis 计数只能做「每天 N 次」，做不了「余额」，也进不了经营看板。
 * 2026-11-02 前 Iris 走的就是 Redis 每日 10 次 + 会员不限次，和 400 点/月的会员体系毫无关系。
 */
export interface IrisCharge {
  mode: IrisMode;
  /** 本次实际扣了多少点（免费次 / 游客 / 限免期为 0） */
  charged: number;
  /** 是否用的是每日免费次 */
  free: boolean;
  /** 上游失败 / 一字未出时退回（幂等：只退一次） */
  refund(): Promise<void>;
}

export interface IrisQuota {
  guest: boolean;
  isMember: boolean;
  /** 今日免费问答已用 / 上限（游客为游客上限） */
  freeUsed: number;
  freeLimit: number;
  /** 点数余额；游客 / 未开通为 null */
  points: number | null;
  activated: boolean;
  costs: Record<IrisMode, number>;
  memberOnly: IrisMode[];
  dailyCap: number;
  dailyUsed: number;
  trialPoints: number;
  memberMonthlyPoints: number;
  /** 北京时间次日零点 */
  resetAt: string;
  /** 兼容旧前端：used/limit 即免费次数 */
  used: number;
  limit: number | null;
}

const DAY_SECONDS = 86400;

/** 北京日期 YYYY-MM-DD（免费次数按北京日重置，和用户的「今天」一致）。 */
export function bjDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 北京时间次日零点的 ISO 时刻。 */
export function bjNextMidnight(now = new Date()): string {
  const day = bjDay(now);
  return new Date(Date.parse(`${day}T00:00:00+08:00`) + DAY_SECONDS * 1000).toISOString();
}

export function isGuestId(userId: string): boolean {
  return !userId || String(userId).startsWith('guest:');
}

/** 点数不足时给用户看的文案：说清差多少、三条出路（开会员 / 加油包 / 邀请）。 */
export function creditExhaustedText(cost: number, balance: number): string {
  return (
    `CREDIT_EXHAUSTED:点数不足：本次需要 ${cost} 点，余额 ${balance} 点。` +
    `开通会员每月领 ${MEMBER_MONTHLY_POINTS} 点，或购买加油包；` +
    `邀请好友注册，双方各得 ${REFERRAL_REWARD.inviter} 点。`
  );
}

const NOOP_CHARGE = (mode: IrisMode, free = false): IrisCharge => ({
  mode,
  charged: 0,
  free,
  refund: async () => undefined,
});

/** 最小 Redis 依赖（便于单测注入替身） */
export interface CounterStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<any>;
  get(key: string): Promise<string | null>;
  decr?(key: string): Promise<number>;
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class IrisCreditService {
  @Inject()
  redisService: RedisService;

  @Inject()
  dataSourceManager: TypeORMDataSourceManager;

  @Config('membership')
  membershipConfig: MembershipConfig;

  /** 单测可直接赋值替身；生产懒建（库连接在 DataSourceManager 里） */
  billing: BillingStore | null = null;
  analytics: Analytics | null = null;
  counter: CounterStore | null = null;
  now: () => Date = () => new Date();

  private getBilling(): BillingStore {
    if (!this.billing) {
      const ds = this.dataSourceManager.getDataSource('default');
      const q = (sql: string, params?: any[]) => ds.query(sql, params);
      this.billing = new BillingStore(q);
      this.analytics = this.analytics || new Analytics(q);
    }
    return this.billing;
  }

  private getCounter(): CounterStore {
    return this.counter || (this.redisService as unknown as CounterStore);
  }

  private async bump(key: string): Promise<number | null> {
    try {
      const c = this.getCounter();
      const n = await c.incr(key);
      if (n === 1) await c.expire(key, DAY_SECONDS + 3600);
      return n;
    } catch {
      return null; // Redis 异常：计数失效，调用方按「没有免费次 / 不限上限」处理
    }
  }

  private async peek(key: string): Promise<number> {
    try {
      return parseInt((await this.getCounter().get(key)) || '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  private async unbump(key: string): Promise<void> {
    try {
      const c = this.getCounter();
      if (typeof c.decr === 'function') await c.decr(key);
    } catch {
      /* ignore */
    }
  }

  private freeKey(userId: string) {
    return `iris:free:${bjDay(this.now())}:${userId}`;
  }
  private capKey(userId: string) {
    return `iris:cap:${bjDay(this.now())}:${userId}`;
  }
  private guestKey(userId: string) {
    return `iris:guest:${bjDay(this.now())}:${userId}`;
  }

  private track(event: string, userId: string, props: Record<string, any>) {
    const a = this.analytics;
    if (!a) return Promise.resolve();
    return a
      .track({ event, userId, product: 'agent', props })
      .catch(() => undefined);
  }

  /**
   * 调用前计费。抛错即拒绝（文案见类注释前缀约定）；成功返回 charge，失败时调 refund()。
   */
  async begin(userId: string, isMember: boolean, mode: IrisMode): Promise<IrisCharge> {
    if (isMembershipFree(this.membershipConfig)) return NOOP_CHARGE(mode);

    if (isGuestId(userId)) {
      if (mode !== 'chat') {
        throw R.forbiddenError(
          `RATE_LIMIT:登录后即可使用${mode === 'think' ? '深度思考' : '这项功能'}，新用户送 ${TRIAL_POINTS} 点体验额度`
        );
      }
      const n = await this.bump(this.guestKey(userId));
      if (n !== null && n > IRIS_GUEST_DAILY) {
        throw R.forbiddenError(
          `RATE_LIMIT:今日免费提问已用完（每天 ${IRIS_GUEST_DAILY} 次），登录领 ${TRIAL_POINTS} 点体验额度继续问`
        );
      }
      return NOOP_CHARGE(mode, true);
    }

    if (IRIS_MEMBER_ONLY.includes(mode) && !isMember) {
      throw R.forbiddenError(
        `MEMBER_ONLY:${mode === 'interview' ? '模拟面试' : '复盘报告'}为会员专享，开通会员后立即可用`
      );
    }

    const cap = IRIS_DAILY_CAP[isMember ? 'member' : 'free'];
    const used = await this.bump(this.capKey(userId));
    if (used !== null && used > cap) {
      throw R.forbiddenError(`RATE_LIMIT:今日 Iris 调用已达上限（${cap} 次），明天再来`);
    }

    if (mode === 'chat') {
      const freeKey = this.freeKey(userId);
      const n = await this.bump(freeKey);
      if (n !== null && n <= IRIS_FREE_DAILY) {
        return {
          mode,
          charged: 0,
          free: true,
          refund: async () => this.unbump(freeKey),
        };
      }
    }

    const cost = irisCost(mode);
    const ref = irisLedgerRef(mode);
    const billing = this.getBilling();
    const { created } = await billing.activate(userId);
    if (created) {
      await this.track('account_activated', userId, { created: true, via: 'iris' });
      await this.track('trial_granted', userId, { points: TRIAL_POINTS });
    }
    const left = await billing.charge(userId, cost, ref);
    if (left === null) {
      const balance = (await billing.getAccount(userId))?.points ?? 0;
      await this.track('credit_exhausted', userId, {
        tool: ref,
        cost,
        balance,
        tier: isMember ? 'member' : 'free',
        via: 'iris',
      });
      throw R.forbiddenError(creditExhaustedText(cost, balance));
    }
    let refunded = false;
    return {
      mode,
      charged: cost,
      free: false,
      refund: async () => {
        if (refunded) return;
        refunded = true;
        await billing.refund(userId, cost, ref).catch(() => undefined);
      },
    };
  }

  /** 额度概览（/api/ai/quota 与 user.getUserById 的 aiQuota 共用） */
  async quota(userId: string, isMember: boolean): Promise<IrisQuota> {
    const guest = isGuestId(userId);
    const free = isMembershipFree(this.membershipConfig);
    const base = {
      guest,
      isMember: free || isMember,
      costs: { ...IRIS_COST },
      memberOnly: [...IRIS_MEMBER_ONLY],
      trialPoints: TRIAL_POINTS,
      memberMonthlyPoints: MEMBER_MONTHLY_POINTS,
      resetAt: bjNextMidnight(this.now()),
    };
    if (free) {
      return {
        ...base,
        freeUsed: 0,
        freeLimit: 0,
        points: null,
        activated: false,
        dailyCap: 0,
        dailyUsed: 0,
        used: 0,
        limit: null,
      };
    }
    if (guest) {
      const used = Math.min(IRIS_GUEST_DAILY, await this.peek(this.guestKey(userId)));
      return {
        ...base,
        freeUsed: used,
        freeLimit: IRIS_GUEST_DAILY,
        points: null,
        activated: false,
        dailyCap: IRIS_GUEST_DAILY,
        dailyUsed: used,
        used,
        limit: IRIS_GUEST_DAILY,
      };
    }
    const freeUsed = Math.min(IRIS_FREE_DAILY, await this.peek(this.freeKey(userId)));
    const dailyUsed = await this.peek(this.capKey(userId));
    let points: number | null = null;
    let activated = false;
    try {
      const acct = await this.getBilling().getAccount(userId);
      if (acct) {
        activated = true;
        points = acct.points;
      }
    } catch {
      /* 库不可用：只少一块余额展示 */
    }
    return {
      ...base,
      freeUsed,
      freeLimit: IRIS_FREE_DAILY,
      points,
      activated,
      dailyCap: IRIS_DAILY_CAP[isMember ? 'member' : 'free'],
      dailyUsed,
      used: freeUsed,
      limit: IRIS_FREE_DAILY,
    };
  }
}

/** 从错误文案取协议前缀（SSE error 帧与 JSON 错误都带 code，前端按 code 分流、不解析文案）。 */
export function irisErrorCode(message: unknown): 'RATE_LIMIT' | 'CREDIT_EXHAUSTED' | 'MEMBER_ONLY' | null {
  const m = String(message || '');
  if (m.startsWith('RATE_LIMIT:')) return 'RATE_LIMIT';
  if (m.startsWith('CREDIT_EXHAUSTED:')) return 'CREDIT_EXHAUSTED';
  if (m.startsWith('MEMBER_ONLY:')) return 'MEMBER_ONLY';
  return null;
}
