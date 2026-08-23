import { Provide, Inject, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { RedisService } from '@midwayjs/redis';
import { MemberEntitlementEntity } from '../../entity/memberEntitlement';
import { isMembershipFree, MembershipConfig } from '../../common/membership';

/** 权益键定义（PRD-07 §4.1 F1）：memberOnly + 可选限次。 */
interface BenefitDef {
  /** 是否会员专享（非会员直接拒） */
  memberOnly: boolean;
  /** 限次周期；不设则不限次 */
  period?: 'day' | 'month';
  /** 免费用户的额度（会员默认不限次，除非 memberLimit 指定成本保险丝） */
  freeLimit?: number;
  /** 会员额度（成本保险丝，如评审 10/日、模拟面试 1/日）；不设则会员不限 */
  memberLimit?: number;
  /** 从环境变量读额度（覆盖 freeLimit） */
  freeLimitEnv?: string;
}

/**
 * 全套件权益键（PRD-07 权益总表的执行版，单轨制）。数值可配。
 * 说明：限免期（MEMBERSHIP_FREE）与试用/购买有效期内 member=true，memberOnly 全放行。
 */
const BENEFITS: Record<string, BenefitDef> = {
  // 教练对话：非会员每日配额（防滥用，非功能阉割），会员不限
  coach_chat_daily: { memberOnly: false, period: 'day', freeLimit: 10, freeLimitEnv: 'AI_RATE_FREE' },
  // 领新题：会员/试用权益
  mission_access: { memberOnly: true },
  // AI 评审：会员不限次，但带成本保险丝（每日上限）
  review_attempt: { memberOnly: true, period: 'day', memberLimit: 10 },
  // AI 个性化学习计划
  plan_ai: { memberOnly: true },
  // 讲给 AI 听（费曼）
  feynman: { memberOnly: true },
  // 模拟面试：会员每日 1 场（成本保险丝）
  mock_interview: { memberOnly: true, period: 'day', memberLimit: 1 },
  // 作品档案 PDF 导出
  portfolio_export: { memberOnly: true },
  // 真人服务 8 折资格
  service_discount: { memberOnly: true },
  // 推荐项目·手把手陪跑指南
  guided_mission: { memberOnly: true },
  // 面试知识点 PDF（收费日起并入会员权益；限免期该 SKU 仍独立售卖，见前端 PDF_AS_MEMBER_BENEFIT）
  materials_pdf: { memberOnly: true },
};

export interface CheckResult {
  allowed: boolean;
  /** 拒绝原因码，前端据此弹对应导购，形如 ENTITLEMENT:mission_access:member_only */
  reason?: string;
  /** 剩余额度（有限次时） */
  remaining?: number;
}

/**
 * 注册赠送的试用天数——**唯一真相源**。
 * 注册链路有两处写入：user.createUser 的 isMember/memberDate 列 与 grantTrial 的权益记录，
 * 两处必须同步（各写各的天数正是 2026-08 那次「承诺未兑现」事故的同类隐患）。
 * 改这里同时改前端文案 `loginModal` / 首页 CTA / memberModal 的「14 天」字样。
 */
export const TRIAL_DAYS = 14;

/**
 * 权益网关（PRD-07 §4.1 F1）。全站付费边界的唯一判定入口，数值集中配置。
 *
 * 灰度：ENTITLEMENT_ENABLED 关闭时，isMember 仍可用（回落 MEMBERSHIP_FREE + 存量记录），
 * 但各业务模块自身也有灰度开关，未开启的模块不会调用 check——因此本服务上线零线上影响。
 */
@Provide()
export class EntitlementService {
  @InjectEntityModel(MemberEntitlementEntity)
  entModel: Repository<MemberEntitlementEntity>;

  @Inject()
  redisService: RedisService;

  @Config('membership')
  membershipConfig: MembershipConfig;

  @Config('entitlement')
  entConfig: { enabled: boolean };

  /** 是否存在有效的会员权益记录。 */
  async hasActiveEntitlement(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
      const row = await this.entModel.findOne({
        where: { userId, expireAt: MoreThan(new Date()) },
        order: { expireAt: 'DESC' },
      });
      return !!row;
    } catch {
      return false;
    }
  }

  /** 会员判定：限免期 → 全员会员；否则看有效权益记录。 */
  async isMember(userId: string): Promise<boolean> {
    if (isMembershipFree(this.membershipConfig)) return true;
    return this.hasActiveEntitlement(userId);
  }

  /** 当前有效期到期日（无则 null）。 */
  async currentExpiry(userId: string): Promise<Date | null> {
    try {
      const row = await this.entModel.findOne({
        where: { userId, expireAt: MoreThan(new Date()) },
        order: { expireAt: 'DESC' },
      });
      return row ? new Date(row.expireAt) : null;
    } catch {
      return null;
    }
  }

  /** 注册发放 14 天全功能试用（每手机号一次），对齐注册页「赠送14天会员权益」文案。幂等：已发过 trial 不重复发。 */
  async grantTrial(userId: string): Promise<void> {
    if (!userId) return;
    try {
      const existing = await this.entModel.findOne({ where: { userId, source: 'trial' } });
      if (existing) return;
      const now = new Date();
      const expireAt = new Date(now.getTime() + TRIAL_DAYS * 86400000);
      await this.entModel.save(
        this.entModel.create({ userId, source: 'trial', startAt: now, expireAt, meta: null })
      );
    } catch {
      /* 发放失败不阻断注册 */
    }
  }

  /** 订单核账通过后写入会员权益（有效期从当前有效期顺延）。 */
  async grantFromOrder(
    userId: string,
    plan: 'monthly' | 'yearly',
    orderNo?: string
  ): Promise<void> {
    if (!userId) return;
    const days = plan === 'yearly' ? 366 : 31;
    const active = await this.currentExpiry(userId);
    const base = active && active > new Date() ? active : new Date();
    const expireAt = new Date(base.getTime() + days * 86400000);
    await this.entModel.save(
      this.entModel.create({
        userId,
        source: 'purchase',
        startAt: new Date(),
        expireAt,
        meta: orderNo ? { orderNo, plan } : { plan },
      })
    );
  }

  /** 管理员/脚本赠送（限免退出过渡期 legacy_free 也走这里，传 source）。 */
  async grant(userId: string, days: number, source = 'admin_grant', meta?: any): Promise<void> {
    if (!userId || days <= 0) return;
    const now = new Date();
    const expireAt = new Date(now.getTime() + days * 86400000);
    await this.entModel.save(
      this.entModel.create({ userId, source, startAt: now, expireAt, meta: meta ?? null })
    );
  }

  /**
   * 权益校验（业务模块调用）。member 可由调用方传入避免重复查询。
   * 有限次的返回 remaining；限次自增在此完成（调用即计数）。
   */
  async check(
    userId: string,
    benefitKey: string,
    opts: { isMember?: boolean; consume?: boolean } = {}
  ): Promise<CheckResult> {
    const def = BENEFITS[benefitKey];
    if (!def) return { allowed: true };
    const member = opts.isMember ?? (await this.isMember(userId));

    if (def.memberOnly && !member) {
      return { allowed: false, reason: `ENTITLEMENT:${benefitKey}:member_only` };
    }

    // 限次：会员看 memberLimit（成本保险丝），非会员看 freeLimit
    const limit = member
      ? def.memberLimit
      : def.freeLimitEnv
      ? parseInt(process.env[def.freeLimitEnv] || String(def.freeLimit ?? 0), 10)
      : def.freeLimit;
    if (!def.period || limit == null) return { allowed: true };

    const bucket = def.period === 'day' ? this.dayKey() : this.monthKey();
    const key = `ent:${benefitKey}:${bucket}:${userId}`;
    try {
      const consume = opts.consume !== false;
      let current: number;
      if (consume) {
        current = await this.redisService.incr(key);
        if (current === 1) {
          await this.redisService.expire(key, def.period === 'day' ? 86400 : 2678400);
        }
      } else {
        current = parseInt((await this.redisService.get(key)) || '0', 10) + 1;
      }
      if (current > limit) {
        return { allowed: false, reason: `ENTITLEMENT:${benefitKey}:limit`, remaining: 0 };
      }
      return { allowed: true, remaining: Math.max(0, limit - current) };
    } catch {
      // Redis 异常：宁可多给不误杀
      return { allowed: true };
    }
  }

  /** 权益概要（GET /user/entitlements 用）。 */
  async getEntitlements(userId: string): Promise<any> {
    const member = await this.isMember(userId);
    const expiry = await this.currentExpiry(userId);
    return {
      isMember: member,
      expireAt: expiry ? expiry.toISOString() : null,
      freeForAll: !!isMembershipFree(this.membershipConfig),
      benefits: Object.keys(BENEFITS),
    };
  }

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }
  private monthKey(): string {
    return new Date().toISOString().slice(0, 7);
  }
}
