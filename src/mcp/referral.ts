import type { QueryFn } from './store';
import {
  BillingStore,
  REFERRAL_DAYS,
  REFERRAL_REWARD,
  effectiveTier,
} from './billing';

/**
 * 邀请拉新 / 社群裂变——**各产品共用的通用能力**。
 *
 * 2026-11-02 owner：「引入分享拉新等模式完成产品用户的裂变」→ 第一版「双方得点」。
 * 2026-11-05 owner：做成 Agent Journey / Invest Journey / 栗栗学英语（little-circle）等共用的能力，
 * 奖励里加「免费体验天数」，但要克制、封顶，免得白拿的会员影响付费转化。
 *
 * 模型：
 * - 一个账户（手机号）一个邀请码（user.inviteCode，注册时生成），在哪个产品分享都是同一个码；
 *   一个账户只能有一个邀请人（referral 主键 invitee_id），product 记它是从哪个产品被邀请来的。
 * - 每个产品一份奖励配置（REFERRAL_PROGRAMS）：被邀请人 / 邀请人 / 好友付费 三档，各含点数和会员天数。
 *   点数走共用账户 mcp_account；会员天数写 member_entitlement（目前只有 Agent Journey 的会员认这张表，
 *   其他产品配 0 天，等它们接入权益判定后再开）。
 * - 绑定入口三个：密码注册 /user/create、短信登录自动建号 /auth/sms/login、注册后补填 /referral/bind
 *   （注册 BIND_WINDOW_DAYS 天内，社群里口口相传的邀请码靠它）。规则完全一样，都走 recordSignup。
 *
 * 防刷（参考 Qoder / ChatGPT / Dropbox 的邀请条款）：
 * - 手机号短信验证本身是第一道门槛；自邀、互邀（A 邀 B 后 B 再邀 A）不认；
 * - 同一邀请人 24 小时内同一 IP 的第二个受邀注册：记关系、状态 held、双方都不发注册奖励；
 * - 每个邀请人每自然月最多 monthlyCap 个受邀注册计奖，超出的照样记关系（好友付费仍返）；
 * - 邀请人靠「好友注册」拿的会员天数：每月 ≤ monthlyCapDays、终身 ≤ lifetimeCapDays；
 * - 注册奖励点数：非会员邀请人记体验点（14 天到期），防拉小号攒不过期的点；
 * - 好友付费的返利有真实收入对应，held 的关系同样返、不计天数上限，每个受邀者只返一次。
 *
 * 所有写入失败不影响注册本身（调用方吞错）。
 */

export type ReferralProduct = 'agent' | 'invest' | 'kids';
export const REFERRAL_PRODUCTS: ReferralProduct[] = ['agent', 'invest', 'kids'];

export interface ReferralReward {
  points: number;
  memberDays: number;
}

export interface ReferralProgram {
  product: ReferralProduct;
  name: string;
  /** 分享链接的基础地址（后面拼 invite=<code>）；空串＝由该产品前端自己拼 */
  shareUrl: string;
  /** 好友注册：被邀请人得 */
  invitee: ReferralReward;
  /** 好友注册：邀请人得 */
  inviter: ReferralReward;
  /** 好友开通会员：邀请人得 */
  onPaid: ReferralReward;
  /** 每自然月计奖的受邀注册数 */
  monthlyCap: number;
  /** 邀请人靠好友注册拿到的会员天数：每月 / 终身上限 */
  monthlyCapDays: number;
  lifetimeCapDays: number;
}

/** 注册后多少天内还能补填邀请码 */
export const BIND_WINDOW_DAYS = 7;

const agentProgram: ReferralProgram = {
  product: 'agent',
  name: 'Agent Journey',
  shareUrl: 'https://www.agent-journey.cn/services',
  invitee: {
    points: REFERRAL_REWARD.invitee,
    memberDays: REFERRAL_DAYS.invitee,
  },
  inviter: {
    points: REFERRAL_REWARD.inviter,
    memberDays: REFERRAL_DAYS.inviter,
  },
  onPaid: {
    points: REFERRAL_REWARD.memberBonus,
    memberDays: REFERRAL_DAYS.memberBonus,
  },
  monthlyCap: REFERRAL_REWARD.monthlyCap,
  monthlyCapDays: REFERRAL_DAYS.monthlyCapDays,
  lifetimeCapDays: REFERRAL_DAYS.lifetimeCapDays,
};

/**
 * 各产品的奖励配置。改奖励只改这里（Agent Journey 的数值真源在 billing.REFERRAL_REWARD / REFERRAL_DAYS，
 * 前端从 /mcp/pricing.referral 读）。新产品接入：加一个 product 值 + 一份配置即可。
 */
export const REFERRAL_PROGRAMS: Record<ReferralProduct, ReferralProgram> = {
  agent: agentProgram,
  // Invest 共用点数账户；它的「跟车」会员不认 member_entitlement，所以先只送点
  invest: {
    ...agentProgram,
    product: 'invest',
    name: 'Invest Journey',
    shareUrl: 'https://invest-journey.vercel.app/',
    invitee: { points: REFERRAL_REWARD.invitee, memberDays: 0 },
    inviter: { points: REFERRAL_REWARD.inviter, memberDays: 0 },
    onPaid: { points: REFERRAL_REWARD.memberBonus, memberDays: 0 },
  },
  // 栗栗学英语：目前不收费、没有点数用处，只记邀请关系与成绩，奖励等有付费点再配
  kids: {
    ...agentProgram,
    product: 'kids',
    name: '栗栗学英语',
    // 站点地址由该前端自己拼（?invite=<code>），这里不写死
    shareUrl: '',
    invitee: { points: 0, memberDays: 0 },
    inviter: { points: 0, memberDays: 0 },
    onPaid: { points: 0, memberDays: 0 },
  },
};

export function isReferralProduct(x: unknown): x is ReferralProduct {
  return REFERRAL_PRODUCTS.includes(x as ReferralProduct);
}

export function programOf(product?: unknown): ReferralProgram {
  return REFERRAL_PROGRAMS[isReferralProduct(product) ? product : 'agent'];
}

/** 对外展示用的配置（不含实现细节） */
export function programView(product?: unknown) {
  const p = programOf(product);
  return {
    product: p.product,
    name: p.name,
    shareUrl: p.shareUrl,
    invitee: { ...p.invitee },
    inviter: { ...p.inviter },
    onPaid: { ...p.onPaid },
    monthlyCap: p.monthlyCap,
    monthlyCapDays: p.monthlyCapDays,
    lifetimeCapDays: p.lifetimeCapDays,
    bindWindowDays: BIND_WINDOW_DAYS,
  };
}

export function sanitizeCode(code: unknown): string {
  const c = String(code ?? '').trim();
  return /^[A-Za-z0-9_-]{4,32}$/.test(c) ? c : '';
}

export interface ReferralRow {
  invitee_id: string;
  inviter_id: string;
  code: string;
  product: ReferralProduct;
  ip: string | null;
  status: 'rewarded' | 'held';
  invitee_days: number;
  inviter_days: number;
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
  /** 邀请累计给邀请人带来的会员天数（注册 + 付费返） */
  daysEarned: number;
  /** 本月已计奖的受邀注册数 / 上限 */
  monthUsed: number;
  monthlyCap: number;
  /** 本月 / 累计已拿的注册天数（对比上限） */
  monthDays: number;
  lifetimeDays: number;
  /** 自己的邀请人（脱敏）；没有为 null */
  invitedBy: string | null;
  /** 还能不能补填邀请码（没有邀请人且注册不满 BIND_WINDOW_DAYS 天） */
  canBind: boolean;
  /** Agent Journey 的点数奖励（旧前端读这个） */
  reward: typeof REFERRAL_REWARD;
  program: ReturnType<typeof programView>;
}

export type IgnoreReason =
  | 'no_code'
  | 'unknown_code'
  | 'self'
  | 'circular'
  | 'exists'
  | 'too_late';

export type SignupOutcome =
  | {
      status: 'rewarded';
      inviter: string;
      product: ReferralProduct;
      inviteePoints: number;
      inviterPoints: number;
      inviteeDays: number;
      inviterDays: number;
    }
  | {
      status: 'held';
      inviter: string;
      product: ReferralProduct;
      reason: 'cap' | 'same_ip';
    }
  | { status: 'ignored'; reason: IgnoreReason };

/** 手机号脱敏进流水 ref（邀请人能认出是哪个朋友，但流水里不存全号）。 */
export function maskUser(id: string): string {
  const s = String(id || '');
  if (s.length <= 7) return s.slice(0, 2) + '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 昵称脱敏（落地页「XX 邀请你」用）：保留首字，其余打星，最多显示 4 个字符 */
export function maskNick(nick: unknown): string {
  const s = Array.from(String(nick || '').trim());
  if (!s.length) return '';
  if (s.length === 1) return s[0];
  return s[0] + '*'.repeat(Math.min(3, s.length - 1));
}

const DAY_MS = 86400 * 1000;

function toDate(raw: any): Date | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isFinite(d.getTime()) ? d : null;
}

export class ReferralStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private q: QueryFn, private billing: BillingStore) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.q(`CREATE TABLE IF NOT EXISTS referral (
          invitee_id VARCHAR(64) NOT NULL PRIMARY KEY,
          inviter_id VARCHAR(64) NOT NULL,
          code VARCHAR(32) NOT NULL,
          product VARCHAR(16) NOT NULL DEFAULT 'agent',
          ip VARCHAR(64) NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'rewarded',
          invitee_days INT NOT NULL DEFAULT 0,
          inviter_days INT NOT NULL DEFAULT 0,
          member_bonus_days INT NOT NULL DEFAULT 0,
          signup_reward_at DATETIME NULL,
          member_reward_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_referral_inviter (inviter_id, created_at),
          KEY idx_referral_inviter_ip (inviter_id, ip, created_at)
        ) DEFAULT CHARSET=utf8mb4`);
        // 2026-11-05 通用化：线上表已建，补列（MySQL 8 没有 ADD COLUMN IF NOT EXISTS，先查再补）
        const cols = await this.q(
          "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'referral'"
        );
        const names = new Set(
          (cols || []).map((c: any) => String(c.COLUMN_NAME || c.column_name))
        );
        const add: string[] = [];
        if (!names.has('product'))
          add.push("ADD COLUMN product VARCHAR(16) NOT NULL DEFAULT 'agent'");
        if (!names.has('invitee_days'))
          add.push('ADD COLUMN invitee_days INT NOT NULL DEFAULT 0');
        if (!names.has('inviter_days'))
          add.push('ADD COLUMN inviter_days INT NOT NULL DEFAULT 0');
        if (!names.has('member_bonus_days'))
          add.push('ADD COLUMN member_bonus_days INT NOT NULL DEFAULT 0');
        if (add.length) await this.q(`ALTER TABLE referral ${add.join(', ')}`);
      })().catch(e => {
        this.schemaReady = null;
        throw e;
      });
    }
    return this.schemaReady;
  }

  /** 邀请码 → 邀请人（user 表的 inviteCode 列；注册时 uuid 前 8 位） */
  async inviterOf(code: string): Promise<string | null> {
    const c = sanitizeCode(code);
    if (!c) return null;
    const rows = await this.q(
      'SELECT phoneNumber FROM `user` WHERE inviteCode = ? LIMIT 1',
      [c]
    );
    return rows?.[0]?.phoneNumber ? String(rows[0].phoneNumber) : null;
  }

  /** 落地页用：邀请码是否有效 + 邀请人脱敏昵称。不暴露手机号。 */
  async lookup(
    code: string
  ): Promise<{ valid: boolean; inviterNick: string | null }> {
    const c = sanitizeCode(code);
    if (!c) return { valid: false, inviterNick: null };
    const rows = await this.q(
      'SELECT nickName FROM `user` WHERE inviteCode = ? LIMIT 1',
      [c]
    ).catch(() =>
      this.q('SELECT 1 AS ok FROM `user` WHERE inviteCode = ? LIMIT 1', [c])
    );
    if (!rows?.[0]) return { valid: false, inviterNick: null };
    return { valid: true, inviterNick: maskNick(rows[0].nickName) || null };
  }

  /** 本月（库时区自然月）已计奖的受邀注册数。时间一律用库里的 NOW()，和各表 created_at 默认值同一个钟。 */
  async monthRewarded(inviter: string): Promise<number> {
    const rows = await this.q(
      "SELECT COUNT(*) AS n FROM referral WHERE inviter_id = ? AND signup_reward_at IS NOT NULL AND signup_reward_at >= DATE_FORMAT(NOW(), '%Y-%m-01')",
      [inviter]
    );
    return Number(rows?.[0]?.n ?? 0);
  }

  /** 邀请人靠好友注册已拿的会员天数：本月 / 累计 */
  async inviterDaysUsed(
    inviter: string
  ): Promise<{ month: number; lifetime: number }> {
    const rows = await this.q(
      `SELECT COALESCE(SUM(inviter_days), 0) AS lifetime,
              COALESCE(SUM(CASE WHEN signup_reward_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN inviter_days ELSE 0 END), 0) AS month
         FROM referral WHERE inviter_id = ?`,
      [inviter]
    );
    return {
      month: Number(rows?.[0]?.month ?? 0),
      lifetime: Number(rows?.[0]?.lifetime ?? 0),
    };
  }

  /** 注册是否还在补填窗口内（user.createTime 在 BIND_WINDOW_DAYS 天内）。查不到注册时间按不允许。 */
  async withinBindWindow(userId: string): Promise<boolean> {
    const rows = await this.q(
      `SELECT 1 AS ok FROM \`user\` WHERE phoneNumber = ? AND createTime >= NOW() - INTERVAL ${BIND_WINDOW_DAYS} DAY LIMIT 1`,
      [userId]
    ).catch(() => []);
    return !!rows?.[0];
  }

  /**
   * 送会员天数：写 member_entitlement（source=referral），从当前会员到期日（权益记录与 Skill 会员取较晚者）顺延。
   * 与 EntitlementService.grant 同一张表、同一种时间写法（JS Date 参数交给驱动按连接时区序列化）。
   * 失败返回 0（表不存在等），不影响点数奖励与注册。
   */
  async grantMemberDays(
    userId: string,
    days: number,
    ref: string
  ): Promise<number> {
    if (!userId || days <= 0) return 0;
    try {
      const [ent, skill] = await Promise.all([
        this.q(
          'SELECT MAX(expireAt) AS e FROM member_entitlement WHERE userId = ?',
          [userId]
        ),
        this.q(
          "SELECT tier_expire_at AS e FROM mcp_account WHERE user_id = ? AND tier IN ('member','starter','pro') " +
            'AND tier_expire_at IS NOT NULL AND tier_expire_at > NOW() LIMIT 1',
          [userId]
        ).catch(() => []),
      ]);
      const now = new Date();
      let base = now;
      for (const raw of [ent?.[0]?.e, skill?.[0]?.e]) {
        const d = toDate(raw);
        if (d && d > base) base = d;
      }
      const expireAt = new Date(base.getTime() + days * DAY_MS);
      await this.q(
        'INSERT INTO member_entitlement (userId, source, startAt, expireAt, meta) VALUES (?, ?, ?, ?, ?)',
        [userId, 'referral', now, expireAt, JSON.stringify({ ref, days })]
      );
      return days;
    } catch (e) {
      console.warn('[referral] grantMemberDays failed', (e as any)?.message);
      return 0;
    }
  }

  /**
   * 建立邀请关系并发注册奖励（注册成功之后 / 注册后补填时调用）。幂等：同一受邀者只记一次。
   * requireWindow：补填入口要求注册不满 BIND_WINDOW_DAYS 天（注册当下调用不用查）。
   */
  async recordSignup(p: {
    inviteeId: string;
    code?: string | null;
    ip?: string | null;
    product?: string | null;
    requireWindow?: boolean;
  }): Promise<SignupOutcome> {
    const code = sanitizeCode(p.code);
    if (!code)
      return { status: 'ignored', reason: p.code ? 'unknown_code' : 'no_code' };
    await this.ensureSchema();
    const inviter = await this.inviterOf(code);
    if (!inviter) return { status: 'ignored', reason: 'unknown_code' };
    if (inviter === p.inviteeId) return { status: 'ignored', reason: 'self' };
    // 互邀：邀请人自己是被这个新用户邀请来的
    const back = await this.q(
      'SELECT 1 AS x FROM referral WHERE invitee_id = ? AND inviter_id = ? LIMIT 1',
      [inviter, p.inviteeId]
    );
    if (back?.[0]) return { status: 'ignored', reason: 'circular' };
    if (p.requireWindow && !(await this.withinBindWindow(p.inviteeId)))
      return { status: 'ignored', reason: 'too_late' };

    const program = programOf(p.product);
    const product = program.product;
    const ip = p.ip ? String(p.ip).slice(0, 64) : null;
    let hold: 'cap' | 'same_ip' | null = null;
    if (ip) {
      const dup = await this.q(
        'SELECT COUNT(*) AS n FROM referral WHERE inviter_id = ? AND ip = ? AND created_at >= NOW() - INTERVAL 1 DAY',
        [inviter, ip]
      );
      if (Number(dup?.[0]?.n ?? 0) > 0) hold = 'same_ip';
    }
    if (!hold && (await this.monthRewarded(inviter)) >= program.monthlyCap)
      hold = 'cap';

    const r = await this.q(
      hold
        ? "INSERT IGNORE INTO referral (invitee_id, inviter_id, code, product, ip, status, signup_reward_at) VALUES (?, ?, ?, ?, ?, 'held', NULL)"
        : "INSERT IGNORE INTO referral (invitee_id, inviter_id, code, product, ip, status, signup_reward_at) VALUES (?, ?, ?, ?, ?, 'rewarded', NOW())",
      [p.inviteeId, inviter, code, product, ip]
    );
    if (Number(r?.affectedRows ?? 0) === 0)
      return { status: 'ignored', reason: 'exists' };
    if (hold) return { status: 'held', inviter, product, reason: hold };

    // —— 被邀请人：点数并入体验桶（与体验点同性质、一起到期，2026-11-04 方案 A）+ 会员天数
    if (program.invitee.points > 0) {
      await this.billing.activate(p.inviteeId);
      await this.billing.addTrialPoints(
        p.inviteeId,
        program.invitee.points,
        'referral',
        code,
        '好友邀请注册奖励'
      );
    }
    const inviteeDays = await this.grantMemberDays(
      p.inviteeId,
      program.invitee.memberDays,
      `invited:${code}`
    );

    // —— 邀请人：非会员记体验点、14 天到期（否则拉小号注册＝每月 300 点不过期的白用口子）；会员照常发普通点
    if (program.inviter.points > 0) {
      const inviterAcc = await this.billing
        .getAccount(inviter)
        .catch(() => null);
      const inviterAdd =
        effectiveTier(inviterAcc) === 'member'
          ? this.billing.addPoints.bind(this.billing)
          : this.billing.addTrialPoints.bind(this.billing);
      await inviterAdd(
        inviter,
        program.inviter.points,
        'referral',
        maskUser(p.inviteeId),
        '邀请好友注册奖励'
      );
    }
    // 邀请人的注册天数受月 / 终身上限约束
    let inviterDays = 0;
    if (program.inviter.memberDays > 0) {
      const used = await this.inviterDaysUsed(inviter);
      const allow = Math.max(
        0,
        Math.min(
          program.inviter.memberDays,
          program.monthlyCapDays - used.month,
          program.lifetimeCapDays - used.lifetime
        )
      );
      inviterDays = await this.grantMemberDays(
        inviter,
        allow,
        `invite:${maskUser(p.inviteeId)}`
      );
    }
    await this.q(
      'UPDATE referral SET invitee_days = ?, inviter_days = ? WHERE invitee_id = ?',
      [inviteeDays, inviterDays, p.inviteeId]
    );
    return {
      status: 'rewarded',
      inviter,
      product,
      inviteePoints: program.invitee.points,
      inviterPoints: program.inviter.points,
      inviteeDays,
      inviterDays,
    };
  }

  /**
   * 受邀者开通会员（plan SKU 到账）时调用：邀请人按受邀者所属产品的 onPaid 发点 + 天数，每个受邀者只一次。
   * held 的关系同样计奖——刷点的风险在注册奖励那一层，真掏钱开会员的是真用户。
   */
  async onMemberPaid(
    inviteeId: string
  ): Promise<{ inviter: string; points: number; days: number } | null> {
    await this.ensureSchema();
    const r = await this.q(
      'UPDATE referral SET member_reward_at = NOW() WHERE invitee_id = ? AND member_reward_at IS NULL',
      [inviteeId]
    );
    if (Number(r?.affectedRows ?? 0) === 0) return null;
    const rows = await this.q(
      'SELECT inviter_id, product FROM referral WHERE invitee_id = ? LIMIT 1',
      [inviteeId]
    );
    const inviter = rows?.[0]?.inviter_id ? String(rows[0].inviter_id) : null;
    if (!inviter) return null;
    const program = programOf(rows[0].product);
    if (program.onPaid.points > 0)
      await this.billing.addPoints(
        inviter,
        program.onPaid.points,
        'referral_member',
        maskUser(inviteeId),
        '邀请的好友开通会员'
      );
    const days = await this.grantMemberDays(
      inviter,
      program.onPaid.memberDays,
      `paid:${maskUser(inviteeId)}`
    );
    if (days > 0)
      await this.q(
        'UPDATE referral SET member_bonus_days = ? WHERE invitee_id = ?',
        [days, inviteeId]
      );
    return { inviter, points: program.onPaid.points, days };
  }

  async stats(
    inviter: string,
    product?: string | null
  ): Promise<ReferralStats> {
    await this.ensureSchema();
    const [agg, ledger, codeRows, mine] = await Promise.all([
      this.q(
        `SELECT COUNT(*) AS invited,
                SUM(status = 'rewarded') AS rewarded,
                SUM(status = 'held') AS held,
                SUM(member_reward_at IS NOT NULL) AS members,
                COALESCE(SUM(inviter_days + member_bonus_days), 0) AS days
           FROM referral WHERE inviter_id = ?`,
        [inviter]
      ),
      this.q(
        "SELECT COALESCE(SUM(delta), 0) AS pts FROM mcp_points_ledger WHERE user_id = ? AND reason IN ('referral','referral_member')",
        [inviter]
      ).catch(() => [{ pts: 0 }]),
      this.q('SELECT inviteCode FROM `user` WHERE phoneNumber = ? LIMIT 1', [
        inviter,
      ]).catch(() => []),
      this.q('SELECT inviter_id FROM referral WHERE invitee_id = ? LIMIT 1', [
        inviter,
      ]),
    ]);
    const a = agg?.[0] || {};
    const program = programOf(product);
    const used = await this.inviterDaysUsed(inviter);
    const invitedBy = mine?.[0]?.inviter_id
      ? maskUser(String(mine[0].inviter_id))
      : null;
    return {
      code: codeRows?.[0]?.inviteCode ? String(codeRows[0].inviteCode) : null,
      invited: Number(a.invited ?? 0),
      rewarded: Number(a.rewarded ?? 0),
      held: Number(a.held ?? 0),
      members: Number(a.members ?? 0),
      pointsEarned: Number(ledger?.[0]?.pts ?? 0),
      daysEarned: Number(a.days ?? 0),
      monthUsed: await this.monthRewarded(inviter),
      monthlyCap: program.monthlyCap,
      monthDays: used.month,
      lifetimeDays: used.lifetime,
      invitedBy,
      canBind: !invitedBy && (await this.withinBindWindow(inviter)),
      reward: { ...REFERRAL_REWARD },
      program: programView(product),
    };
  }
}
