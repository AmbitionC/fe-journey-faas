import { Provide, Inject, Scope, ScopeEnum } from '@midwayjs/core';
import { TypeORMDataSourceManager } from '@midwayjs/typeorm';
import { BillingStore } from '../mcp/billing';
import { ReferralStore, ReferralStats, SignupOutcome } from '../mcp/referral';
import { Analytics } from '../mcp/analytics';

/**
 * 邀请拉新的 Midway 入口（/user/create 注册后记关系、/user/referral 看成绩）。
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

  private getStore(): ReferralStore {
    if (!this.store) {
      const ds = this.dataSourceManager.getDataSource('default');
      const q = (sql: string, params?: any[]) => ds.query(sql, params);
      this.store = new ReferralStore(q, new BillingStore(q));
      this.analytics = this.analytics || new Analytics(q);
    }
    return this.store;
  }

  /** 注册成功后调用；任何失败只记日志不抛。 */
  async recordSignup(inviteeId: string, code?: string | null, ip?: string | null): Promise<SignupOutcome | null> {
    if (!code) return null;
    try {
      const r = await this.getStore().recordSignup({ inviteeId, code, ip });
      if (r.status !== 'ignored') {
        await this.analytics
          ?.track({
            event: 'referral_signup',
            userId: inviteeId,
            product: 'agent',
            props: { inviter: r.inviter, status: r.status, reason: (r as any).reason || null },
          })
          .catch(() => undefined);
      }
      return r;
    } catch (e) {
      console.warn('[referral] recordSignup failed', (e as any)?.message);
      return null;
    }
  }

  async stats(userId: string): Promise<ReferralStats> {
    return this.getStore().stats(userId);
  }
}
