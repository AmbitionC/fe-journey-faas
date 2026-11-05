import { Provide, Inject, Scope, ScopeEnum } from '@midwayjs/core';
import { TypeORMDataSourceManager } from '@midwayjs/typeorm';
import { BillingStore } from '../mcp/billing';
import {
  ReferralStore,
  ReferralStats,
  SignupOutcome,
  programOf,
} from '../mcp/referral';
import { Analytics } from '../mcp/analytics';

/**
 * 邀请裂变的 Midway 入口（各产品共用）：
 * - 注册当下：/user/create、/auth/sms/login 自动建号后调 recordSignup；
 * - 注册后补填：/referral/bind（注册 7 天内）；
 * - /referral/me 看成绩，/referral/program 看规则 + 校验邀请码（落地页横幅用）。
 * 真正的规则在 mcp/referral.ts（纯 SQL 类，可对真库单测）；这里只负责从容器拿库连接并吞错——
 * 邀请关系写失败绝不能让注册失败。
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class ReferralService {
  @Inject()
  dataSourceManager: TypeORMDataSourceManager;

  /** 单测可注入替身 */
  store: ReferralStore | null = null;
  analytics: Analytics | null = null;

  getStore(): ReferralStore {
    if (!this.store) {
      const ds = this.dataSourceManager.getDataSource('default');
      const q = (sql: string, params?: any[]) => ds.query(sql, params);
      this.store = new ReferralStore(q, new BillingStore(q));
      this.analytics = this.analytics || new Analytics(q);
    }
    return this.store;
  }

  private async trackOutcome(
    inviteeId: string,
    r: SignupOutcome,
    product: string,
    via: string
  ) {
    if (r.status === 'ignored') return;
    await this.analytics
      ?.track({
        event: 'referral_signup',
        userId: inviteeId,
        product,
        props: {
          inviter: r.inviter,
          status: r.status,
          reason: (r as any).reason || null,
          via,
          inviteeDays: (r as any).inviteeDays ?? 0,
          inviterDays: (r as any).inviterDays ?? 0,
        },
      })
      .catch(() => undefined);
  }

  /** 注册成功后调用；任何失败只记日志不抛。 */
  async recordSignup(
    inviteeId: string,
    code?: string | null,
    ip?: string | null,
    product?: string | null,
    via = 'signup'
  ): Promise<SignupOutcome | null> {
    if (!code) return null;
    const p = programOf(product).product;
    try {
      const r = await this.getStore().recordSignup({
        inviteeId,
        code,
        ip,
        product: p,
      });
      await this.trackOutcome(inviteeId, r, p, via);
      return r;
    } catch (e) {
      console.warn('[referral] recordSignup failed', (e as any)?.message);
      return null;
    }
  }

  /** 注册后补填邀请码（只在注册 BIND_WINDOW_DAYS 天内有效）。错误照常抛给接口层。 */
  async bind(
    inviteeId: string,
    code: string,
    ip?: string | null,
    product?: string | null
  ): Promise<SignupOutcome> {
    const p = programOf(product).product;
    const r = await this.getStore().recordSignup({
      inviteeId,
      code,
      ip,
      product: p,
      requireWindow: true,
    });
    await this.trackOutcome(inviteeId, r, p, 'bind');
    return r;
  }

  async stats(userId: string, product?: string | null): Promise<ReferralStats> {
    return this.getStore().stats(userId, product);
  }

  async lookup(code: string) {
    return this.getStore().lookup(code);
  }
}
