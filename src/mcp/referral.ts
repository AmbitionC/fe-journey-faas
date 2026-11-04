import type { QueryFn } from './store';
import { BillingStore, REFERRAL_REWARD, effectiveTier } from './billing';

/**
 * 邀请拉新（owner 2026-11-02：「引入分享拉新等模式完成产品用户的裂变」）。
 *
 * 规则（数值真源 billing.REFERRAL_REWARD，前端从 /mcp/pricing 读、不写死）：
 * - 新用户带邀请码注册 → 双方各得 REFERRAL_REWARD.invitee / inviter 点，入 mcp_points_ledger（reason=referral）；
 * - 受邀者之后开通会员（任一 plan SKU 到账）→ 邀请人再得 memberBonus 点（reason=referral_member），每个受邀者只奖一次；
 * - 每个邀请人每个自然月最多 monthlyCap 个受邀注册计奖，超出的照样记关系（将来开会员仍给邀请人加点），但注册奖励不发；
 * - 同一邀请人 24 小时内来自同一 IP 的第二个受邀注册视为自邀刷点：记关系、状态 held、双方都不发注册奖励。
 *
 * 奖励：受邀者账户不存在时先 activate（顺手送体验点）；注册奖励记体验点（14 天到期，邀请人是会员时记普通点），
 * 所以受邀新用户到手 = 体验点 + 邀请奖励。所有写入失败不影响注册本身（调用方吞错）。
 */
export interface ReferralRow {
  invitee_id: string;
  inviter_id: string;
  code: string;
  ip: string | null;
  status: 'rewarded' | 'held';
  signup_reward_at: string | null;
  member_reward_at: string | null;
  created_at: string;
}

export interface ReferralStats {
  code: string | null;
  invited: number;
  rewarded: number;
  held: number;
  members: number;
  /** 邀请累计给邀请人带来的点数 */
  pointsEarned: number;
  /** 本月已计奖的受邀注册数 / 上限 */
  monthUsed: number;
  monthlyCap: number;
  reward: typeof REFERRAL_REWARD;
}

export type SignupOutcome =
  | { status: 'rewarded'; inviter: string; inviteePoints: number; inviterPoints: number }
  | { status: 'held'; inviter: string; reason: 'cap' | 'same_ip' }
  | { status: 'ignored'; reason: 'no_code' | 'unknown_code' | 'self' | 'exists' };

/** 手机号脱敏进流水 ref（邀请人能认出是哪个朋友，但流水里不存全号）。 */
export function maskUser(id: string): string {
  const s = String(id || '');
  if (s.length <= 7) return s.slice(0, 2) + '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

export class ReferralStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private q: QueryFn, private billing: BillingStore) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.q(`CREATE TABLE IF NOT EXISTS referral (
          invitee_id VARCHAR(64) NOT NULL PRIMARY KEY,
          inviter_id VARCHAR(64) NOT NULL,
          code VARCHAR(32) NOT NULL,
          ip VARCHAR(64) NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'rewarded',
          signup_reward_at DATETIME NULL,
          member_reward_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_referral_inviter (inviter_id, created_at),
          KEY idx_referral_inviter_ip (inviter_id, ip, created_at)
        ) DEFAULT CHARSET=utf8mb4`).then(
        () => undefined,
        e => {
          this.schemaReady = null;
          throw e;
        }
      );
    }
    return this.schemaReady;
  }

  /** 邀请码 → 邀请人（user 表的 inviteCode 列；注册时 uuid 前 8 位） */
  async inviterOf(code: string): Promise<string | null> {
    const c = String(code || '').trim();
    if (!c || c.length > 32) return null;
    const rows = await this.q(
      'SELECT phoneNumber FROM `user` WHERE inviteCode = ? LIMIT 1',
      [c]
    );
    return rows?.[0]?.phoneNumber ? String(rows[0].phoneNumber) : null;
  }

  /** 本月（库时区自然月）已计奖的受邀注册数。时间一律用库里的 NOW()，和各表 created_at 默认值同一个钟。 */
  async monthRewarded(inviter: string): Promise<number> {
    const rows = await this.q(
      "SELECT COUNT(*) AS n FROM referral WHERE inviter_id = ? AND signup_reward_at IS NOT NULL AND signup_reward_at >= DATE_FORMAT(NOW(), '%Y-%m-01')",
      [inviter]
    );
    return Number(rows?.[0]?.n ?? 0);
  }

  /**
   * 新用户注册时调用（注册成功之后）。幂等：同一受邀者只记一次。
   */
  async recordSignup(p: {
    inviteeId: string;
    code?: string | null;
    ip?: string | null;
  }): Promise<SignupOutcome> {
    const code = String(p.code || '').trim();
    if (!code) return { status: 'ignored', reason: 'no_code' };
    await this.ensureSchema();
    const inviter = await this.inviterOf(code);
    if (!inviter) return { status: 'ignored', reason: 'unknown_code' };
    if (inviter === p.inviteeId) return { status: 'ignored', reason: 'self' };

    const ip = p.ip ? String(p.ip).slice(0, 64) : null;
    let hold: 'cap' | 'same_ip' | null = null;
    if (ip) {
      const dup = await this.q(
        'SELECT COUNT(*) AS n FROM referral WHERE inviter_id = ? AND ip = ? AND created_at >= NOW() - INTERVAL 1 DAY',
        [inviter, ip]
      );
      if (Number(dup?.[0]?.n ?? 0) > 0) hold = 'same_ip';
    }
    if (!hold && (await this.monthRewarded(inviter)) >= REFERRAL_REWARD.monthlyCap) hold = 'cap';

    const r = await this.q(
      hold
        ? "INSERT IGNORE INTO referral (invitee_id, inviter_id, code, ip, status, signup_reward_at) VALUES (?, ?, ?, ?, 'held', NULL)"
        : "INSERT IGNORE INTO referral (invitee_id, inviter_id, code, ip, status, signup_reward_at) VALUES (?, ?, ?, ?, 'rewarded', NOW())",
      [p.inviteeId, inviter, code.slice(0, 32), ip]
    );
    if (Number(r?.affectedRows ?? 0) === 0) return { status: 'ignored', reason: 'exists' };
    if (hold) return { status: 'held', inviter, reason: hold };

    await this.billing.activate(p.inviteeId);
    // 被邀请人这笔与体验点同性质：并入体验桶、一起到期（2026-11-04 方案 A）
    await this.billing.addTrialPoints(
      p.inviteeId,
      REFERRAL_REWARD.invitee,
      'referral',
      code.slice(0, 64),
      '好友邀请注册奖励'
    );
    // 邀请人注册奖励：非会员同样记体验点、14 天到期（否则拉小号注册＝每月 300 点不过期的白用口子）；
    // 会员照常发普通点。被邀请人开会员的返点（onMemberPaid）有真实收入对应，始终不过期。
    const inviterAcc = await this.billing.getAccount(inviter).catch(() => null);
    const inviterAdd =
      effectiveTier(inviterAcc) === 'member'
        ? this.billing.addPoints.bind(this.billing)
        : this.billing.addTrialPoints.bind(this.billing);
    await inviterAdd(
      inviter,
      REFERRAL_REWARD.inviter,
      'referral',
      maskUser(p.inviteeId),
      '邀请好友注册奖励'
    );
    return {
      status: 'rewarded',
      inviter,
      inviteePoints: REFERRAL_REWARD.invitee,
      inviterPoints: REFERRAL_REWARD.inviter,
    };
  }

  /**
   * 受邀者开通会员（plan SKU 到账）时调用：邀请人加 memberBonus，每个受邀者只一次。
   * held 的关系同样计奖——刷点的风险在注册奖励那一层，真掏钱开会员的是真用户。
   */
  async onMemberPaid(inviteeId: string): Promise<{ inviter: string; points: number } | null> {
    await this.ensureSchema();
    const r = await this.q(
      'UPDATE referral SET member_reward_at = NOW() WHERE invitee_id = ? AND member_reward_at IS NULL',
      [inviteeId]
    );
    if (Number(r?.affectedRows ?? 0) === 0) return null;
    const rows = await this.q('SELECT inviter_id FROM referral WHERE invitee_id = ? LIMIT 1', [inviteeId]);
    const inviter = rows?.[0]?.inviter_id ? String(rows[0].inviter_id) : null;
    if (!inviter) return null;
    await this.billing.addPoints(
      inviter,
      REFERRAL_REWARD.memberBonus,
      'referral_member',
      maskUser(inviteeId),
      '邀请的好友开通会员'
    );
    return { inviter, points: REFERRAL_REWARD.memberBonus };
  }

  async stats(inviter: string): Promise<ReferralStats> {
    await this.ensureSchema();
    const [agg, ledger, codeRows] = await Promise.all([
      this.q(
        `SELECT COUNT(*) AS invited,
                SUM(status = 'rewarded') AS rewarded,
                SUM(status = 'held') AS held,
                SUM(member_reward_at IS NOT NULL) AS members
           FROM referral WHERE inviter_id = ?`,
        [inviter]
      ),
      this.q(
        "SELECT COALESCE(SUM(delta), 0) AS pts FROM mcp_points_ledger WHERE user_id = ? AND reason IN ('referral','referral_member')",
        [inviter]
      ).catch(() => [{ pts: 0 }]),
      this.q('SELECT inviteCode FROM `user` WHERE phoneNumber = ? LIMIT 1', [inviter]).catch(() => []),
    ]);
    const a = agg?.[0] || {};
    return {
      code: codeRows?.[0]?.inviteCode ? String(codeRows[0].inviteCode) : null,
      invited: Number(a.invited ?? 0),
      rewarded: Number(a.rewarded ?? 0),
      held: Number(a.held ?? 0),
      members: Number(a.members ?? 0),
      pointsEarned: Number(ledger?.[0]?.pts ?? 0),
      monthUsed: await this.monthRewarded(inviter),
      monthlyCap: REFERRAL_REWARD.monthlyCap,
      reward: { ...REFERRAL_REWARD },
    };
  }
}
