import { randomBytes } from 'crypto';
import { QueryFn } from './store';

/**
 * Journey 点计费：账户余额、会员档位、按次扣点、订单。
 *
 * 定价参照可灵（月卡/年卡 + 点数 + 加油包），owner 2026-10-30 定：
 * 实验阶段按草案价**打折**上线，用户规模起来后恢复原价（改 PLANS 里的 priceCents 即可，
 * listCents 是原价，页面显示划线价）。
 *
 * 规则（刻意从简）：
 * - 1 点 ≈ ¥0.1 的计价单位，Agent / Invest 两个产品共用一个余额。
 * - 会员按月发点：开通时立刻发第一个月，之后每满一个月懒发放（用户下次调用/打开后台时补发），
 *   年卡同理按月发 12 次。点数不过期（实验阶段从宽）。
 * - 加油包一次性加点，与会员无关。
 * - 新用户首次开通送体验点。
 * - 所有时间比较都在 SQL 里用 NOW() 做，避免 FC 实例时区与库时区不一致。
 */

export type Tier = 'free' | 'starter' | 'pro';

export interface TierSpec {
  name: string;
  maxKeys: number;
  dailyLimit: number;
}

export const TIERS: Record<Tier, TierSpec> = {
  free: { name: '体验', maxKeys: 1, dailyLimit: 200 },
  starter: { name: '入门', maxKeys: 2, dailyLimit: 1000 },
  pro: { name: 'Pro', maxKeys: 5, dailyLimit: 5000 },
};

export const TRIAL_POINTS = 100;

export interface Sku {
  sku: string;
  name: string;
  kind: 'plan' | 'pack';
  /** 实际售价（分）——实验阶段体验价 */
  priceCents: number;
  /** 原价（分）——页面划线显示，恢复原价时把 priceCents 改回它 */
  listCents: number;
  tier?: Tier;
  months?: number;
  /** plan：每月发放点数；pack：一次性点数 */
  points: number;
  desc: string;
}

export const SKUS: Sku[] = [
  {
    sku: 'starter_month',
    name: '入门月卡',
    kind: 'plan',
    tier: 'starter',
    months: 1,
    points: 300,
    priceCents: 1990,
    listCents: 2900,
    desc: '每月 300 点 · 2 个 Key · 每日 1000 次',
  },
  {
    sku: 'starter_year',
    name: '入门年卡',
    kind: 'plan',
    tier: 'starter',
    months: 12,
    points: 300,
    priceCents: 13900,
    listCents: 19900,
    desc: '每月 300 点 × 12 个月 · 2 个 Key',
  },
  {
    sku: 'pro_month',
    name: 'Pro 月卡',
    kind: 'plan',
    tier: 'pro',
    months: 1,
    points: 1200,
    priceCents: 4900,
    listCents: 7900,
    desc: '每月 1200 点 · 5 个 Key · 每日 5000 次',
  },
  {
    sku: 'pro_year',
    name: 'Pro 年卡',
    kind: 'plan',
    tier: 'pro',
    months: 12,
    points: 1200,
    priceCents: 39900,
    listCents: 59900,
    desc: '每月 1200 点 × 12 个月 · 5 个 Key',
  },
  {
    sku: 'pack_100',
    name: '加油包 100 点',
    kind: 'pack',
    points: 100,
    priceCents: 690,
    listCents: 1000,
    desc: '一次性 100 点，不过期',
  },
  {
    sku: 'pack_500',
    name: '加油包 500 点',
    kind: 'pack',
    points: 500,
    priceCents: 2990,
    listCents: 4500,
    desc: '一次性 500 点，不过期',
  },
  {
    sku: 'pack_1100',
    name: '加油包 1100 点',
    kind: 'pack',
    points: 1100,
    priceCents: 5900,
    listCents: 8800,
    desc: '一次性 1100 点，不过期',
  },
];

export const PROMO_NOTE =
  '实验阶段体验价，用户规模起来后恢复原价；已购会员在有效期内不受影响。';

export function findSku(sku: string): Sku | undefined {
  return SKUS.find(s => s.sku === sku);
}

/** 每次调用扣多少点。未列出的工具默认 1 点；口径/清单/用量查询免费。 */
export const TOOL_COST: Record<string, number> = {
  knowledge_tree: 1,
  knowledge_search: 1,
  knowledge_get: 2,
  interview_search: 1,
  interview_get: 2,
  mission_list: 1,
  mission_get: 1,
  quiz_get: 1,
  market_snapshot: 2,
  fear_series: 2,
  bias_series: 2,
  macro_series: 1,
  indicator_list: 0,
  methodology_get: 0,
  account_usage: 0,
};

export function toolCost(tool: string): number {
  return TOOL_COST[tool] ?? 1;
}

export interface Account {
  user_id: string;
  points: number;
  tier: Tier;
  /** 档位是否在有效期内（过期即按 free 处理，余额照常可用） */
  active: boolean;
  tier_expire_at: string | null;
  next_grant_at: string | null;
  monthly_points: number;
}

export function effectiveTier(
  a: Pick<Account, 'tier' | 'active'> | null
): Tier {
  if (!a || !a.active) return 'free';
  return (TIERS[a.tier] ? a.tier : 'free') as Tier;
}

export function genOrderNo(now = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
  return `MJ${d}${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** 收款时让用户在转账备注里写的短码（订单号后 6 位），方便人工对账。 */
export function payCode(orderNo: string): string {
  return orderNo.slice(-6);
}

export class BillingStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private q: QueryFn) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_account (
          user_id VARCHAR(64) NOT NULL PRIMARY KEY,
          points INT NOT NULL DEFAULT 0,
          tier VARCHAR(16) NOT NULL DEFAULT 'free',
          tier_expire_at DATETIME NULL,
          next_grant_at DATETIME NULL,
          monthly_points INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) DEFAULT CHARSET=utf8mb4`);
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_points_ledger (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          delta INT NOT NULL,
          reason VARCHAR(16) NOT NULL,
          ref VARCHAR(64) NULL,
          note VARCHAR(255) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_mcp_ledger_user (user_id, created_at),
          KEY idx_mcp_ledger_time (created_at)
        ) DEFAULT CHARSET=utf8mb4`);
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_order (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_no VARCHAR(32) NOT NULL,
          user_id VARCHAR(64) NOT NULL,
          sku VARCHAR(32) NOT NULL,
          amount_cents INT NOT NULL,
          list_cents INT NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          reported_at DATETIME NULL,
          paid_at DATETIME NULL,
          handled_by VARCHAR(128) NULL,
          note VARCHAR(255) NULL,
          UNIQUE KEY uk_mcp_order_no (order_no),
          KEY idx_mcp_order_user (user_id, created_at),
          KEY idx_mcp_order_status (status, created_at)
        ) DEFAULT CHARSET=utf8mb4`);
      })().catch(e => {
        this.schemaReady = null;
        throw e;
      });
    }
    return this.schemaReady;
  }

  private async ledger(
    userId: string,
    delta: number,
    reason: string,
    ref?: string,
    note?: string
  ) {
    await this.q(
      'INSERT INTO mcp_points_ledger (user_id, delta, reason, ref, note) VALUES (?, ?, ?, ?, ?)',
      [
        userId,
        delta,
        reason,
        ref ? ref.slice(0, 64) : null,
        note ? note.slice(0, 255) : null,
      ]
    );
  }

  private async read(userId: string): Promise<Account | null> {
    const rows = await this.q(
      'SELECT user_id, points, tier, tier_expire_at, next_grant_at, monthly_points, ' +
        '(tier_expire_at IS NOT NULL AND tier_expire_at > NOW()) AS active ' +
        'FROM mcp_account WHERE user_id = ?',
      [userId]
    );
    const r = rows?.[0];
    if (!r) return null;
    return {
      user_id: r.user_id,
      points: Number(r.points),
      tier: r.tier,
      active: Number(r.active) === 1,
      tier_expire_at: r.tier_expire_at ? String(r.tier_expire_at) : null,
      next_grant_at: r.next_grant_at ? String(r.next_grant_at) : null,
      monthly_points: Number(r.monthly_points || 0),
    };
  }

  /** 懒发放会员月度点数：每满一个月补一次，直到追平或到期（最多补 24 次）。 */
  private async catchUpGrants(userId: string) {
    for (let i = 0; i < 24; i++) {
      const r = await this.q(
        'UPDATE mcp_account SET points = points + monthly_points, ' +
          'next_grant_at = DATE_ADD(next_grant_at, INTERVAL 1 MONTH) ' +
          'WHERE user_id = ? AND monthly_points > 0 AND next_grant_at IS NOT NULL ' +
          'AND next_grant_at <= NOW() AND tier_expire_at IS NOT NULL AND next_grant_at < tier_expire_at',
        [userId]
      );
      if (Number(r?.affectedRows ?? 0) === 0) return;
      const a = await this.read(userId);
      await this.ledger(
        userId,
        a?.monthly_points || 0,
        'plan_grant',
        undefined,
        '会员月度发放'
      );
    }
  }

  /** 取账户（含懒发放）；不存在返回 null。 */
  async getAccount(userId: string): Promise<Account | null> {
    await this.ensureSchema();
    await this.catchUpGrants(userId);
    return this.read(userId);
  }

  /** 开通（幂等）：首次创建账户并送体验点。返回 { account, created }。 */
  async activate(userId: string) {
    await this.ensureSchema();
    const r = await this.q(
      'INSERT IGNORE INTO mcp_account (user_id, points) VALUES (?, ?)',
      [userId, TRIAL_POINTS]
    );
    const created = Number(r?.affectedRows ?? 0) > 0;
    if (created)
      await this.ledger(
        userId,
        TRIAL_POINTS,
        'trial',
        undefined,
        '新用户体验点'
      );
    return { account: await this.getAccount(userId), created };
  }

  /**
   * 扣点（原子：余额不足不扣）。余额不足时先补发会员月度点再试一次。
   * @returns 扣后余额；余额不足返回 null。
   */
  async charge(
    userId: string,
    cost: number,
    tool: string
  ): Promise<number | null> {
    if (cost <= 0) return (await this.read(userId))?.points ?? 0;
    await this.ensureSchema();
    const tryOnce = async () =>
      Number(
        (
          await this.q(
            'UPDATE mcp_account SET points = points - ? WHERE user_id = ? AND points >= ?',
            [cost, userId, cost]
          )
        )?.affectedRows ?? 0
      ) > 0;
    let ok = await tryOnce();
    if (!ok) {
      await this.catchUpGrants(userId);
      ok = await tryOnce();
    }
    if (!ok) return null;
    await this.ledger(userId, -cost, 'call', tool);
    return (await this.read(userId))?.points ?? 0;
  }

  /** 工具执行失败时退回已扣点数。 */
  async refund(userId: string, cost: number, tool: string) {
    if (cost <= 0) return;
    await this.q(
      'UPDATE mcp_account SET points = points + ? WHERE user_id = ?',
      [cost, userId]
    );
    await this.ledger(userId, cost, 'refund', tool, '调用失败退点');
  }

  async addPoints(
    userId: string,
    points: number,
    reason: string,
    ref?: string,
    note?: string
  ) {
    await this.ensureSchema();
    await this.q(
      'INSERT IGNORE INTO mcp_account (user_id, points) VALUES (?, 0)',
      [userId]
    );
    await this.q(
      'UPDATE mcp_account SET points = points + ? WHERE user_id = ?',
      [points, userId]
    );
    await this.ledger(userId, points, reason, ref, note);
  }

  /**
   * 开通/续费会员。同档位且未过期 → 顺延到期日（月度点照常按月发）；
   * 否则（新开、过期、换档）→ 从现在起算，立刻发第一个月的点。
   */
  async applyPlan(userId: string, sku: Sku, ref: string) {
    await this.ensureSchema();
    await this.q(
      'INSERT IGNORE INTO mcp_account (user_id, points) VALUES (?, 0)',
      [userId]
    );
    const a = await this.getAccount(userId);
    const months = sku.months || 1;
    if (a && a.active && a.tier === sku.tier) {
      await this.q(
        'UPDATE mcp_account SET tier_expire_at = DATE_ADD(tier_expire_at, INTERVAL ? MONTH), monthly_points = ? WHERE user_id = ?',
        [months, sku.points, userId]
      );
      await this.ledger(
        userId,
        0,
        'plan_extend',
        ref,
        `${sku.name} 顺延 ${months} 个月`
      );
      return;
    }
    await this.q(
      'UPDATE mcp_account SET tier = ?, tier_expire_at = DATE_ADD(NOW(), INTERVAL ? MONTH), ' +
        'next_grant_at = DATE_ADD(NOW(), INTERVAL 1 MONTH), monthly_points = ?, points = points + ? WHERE user_id = ?',
      [sku.tier, months, sku.points, sku.points, userId]
    );
    await this.ledger(
      userId,
      sku.points,
      'plan_grant',
      ref,
      `${sku.name} 开通，发放首月点数`
    );
  }

  async ledgerOf(userId: string, limit = 30) {
    await this.ensureSchema();
    return this.q(
      'SELECT delta, reason, ref, note, created_at FROM mcp_points_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, Math.max(1, Math.min(200, limit))]
    );
  }

  // ───────── 订单 ─────────

  async createOrder(userId: string, sku: Sku) {
    await this.ensureSchema();
    // 同一用户同一商品已有未完成订单就复用，避免重复点出一堆待付款
    const open = await this.q(
      "SELECT order_no, sku, amount_cents, status, created_at FROM mcp_order WHERE user_id = ? AND sku = ? AND status IN ('pending','self_reported') ORDER BY id DESC LIMIT 1",
      [userId, sku.sku]
    );
    if (open?.[0]) return { ...open[0], reused: true };
    const orderNo = genOrderNo();
    await this.q(
      'INSERT INTO mcp_order (order_no, user_id, sku, amount_cents, list_cents) VALUES (?, ?, ?, ?, ?)',
      [orderNo, userId, sku.sku, sku.priceCents, sku.listCents]
    );
    return {
      order_no: orderNo,
      sku: sku.sku,
      amount_cents: sku.priceCents,
      status: 'pending',
      reused: false,
    };
  }

  async getOrder(orderNo: string) {
    await this.ensureSchema();
    const rows = await this.q('SELECT * FROM mcp_order WHERE order_no = ?', [
      orderNo,
    ]);
    return rows?.[0] || null;
  }

  async ordersOf(userId: string) {
    await this.ensureSchema();
    return this.q(
      'SELECT order_no, sku, amount_cents, list_cents, status, created_at, reported_at, paid_at FROM mcp_order WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      [userId]
    );
  }

  /** 用户点「我已支付」：pending → self_reported（只能改自己的单）。 */
  async reportPaid(orderNo: string, userId: string): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.q(
      "UPDATE mcp_order SET status = 'self_reported', reported_at = NOW() WHERE order_no = ? AND user_id = ? AND status = 'pending'",
      [orderNo, userId]
    );
    return Number(r?.affectedRows ?? 0) > 0;
  }

  /**
   * 确认到账并发货（幂等：只有 pending/self_reported 能转 paid，重复确认不会重复发点）。
   * @returns 'ok' | 'not_found' | 'already'
   */
  async fulfill(
    orderNo: string,
    actor: string
  ): Promise<'ok' | 'not_found' | 'already'> {
    await this.ensureSchema();
    const o = await this.getOrder(orderNo);
    if (!o) return 'not_found';
    const r = await this.q(
      "UPDATE mcp_order SET status = 'paid', paid_at = NOW(), handled_by = ? WHERE order_no = ? AND status IN ('pending','self_reported')",
      [actor.slice(0, 128), orderNo]
    );
    if (Number(r?.affectedRows ?? 0) === 0) return 'already';
    const sku = findSku(o.sku);
    if (!sku) return 'ok';
    if (sku.kind === 'plan') await this.applyPlan(o.user_id, sku, orderNo);
    else await this.addPoints(o.user_id, sku.points, 'pack', orderNo, sku.name);
    return 'ok';
  }

  async reject(
    orderNo: string,
    actor: string,
    note?: string
  ): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.q(
      "UPDATE mcp_order SET status = 'rejected', handled_by = ?, note = ? WHERE order_no = ? AND status IN ('pending','self_reported')",
      [actor.slice(0, 128), (note || '').slice(0, 255) || null, orderNo]
    );
    return Number(r?.affectedRows ?? 0) > 0;
  }

  async listOrders(status?: string, limit = 100) {
    await this.ensureSchema();
    const w = status ? 'WHERE status = ?' : '';
    return this.q(
      `SELECT order_no, user_id, sku, amount_cents, status, created_at, reported_at, paid_at, handled_by, note FROM mcp_order ${w} ORDER BY id DESC LIMIT ?`,
      status ? [status, Math.min(500, limit)] : [Math.min(500, limit)]
    );
  }

  /** 经营看板：用户、收入、调用、点数消耗。 */
  async stats(days = 30) {
    await this.ensureSchema();
    const d = Math.max(1, Math.min(180, Math.floor(days)));
    const one = async (sql: string, params: any[] = []) =>
      (await this.q(sql, params))?.[0] || {};
    const users = await one(
      'SELECT COUNT(*) total, SUM(tier_expire_at IS NOT NULL AND tier_expire_at > NOW()) paying, ' +
        "SUM(tier = 'pro' AND tier_expire_at > NOW()) pro, SUM(points) points_outstanding FROM mcp_account"
    );
    const revenue = await one(
      "SELECT COALESCE(SUM(amount_cents),0) paid_cents, COUNT(*) paid_orders FROM mcp_order WHERE status = 'paid' AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY)",
      [d]
    );
    const revenueMonth = await one(
      "SELECT COALESCE(SUM(amount_cents),0) paid_cents, COUNT(*) paid_orders FROM mcp_order WHERE status = 'paid' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')"
    );
    const pending = await one(
      "SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM mcp_order WHERE status = 'self_reported'"
    );
    const daily = await this.q(
      'SELECT DATE(created_at) day, ' +
        "SUM(CASE WHEN reason = 'call' THEN 1 ELSE 0 END) calls, " +
        "SUM(CASE WHEN reason = 'call' THEN -delta ELSE 0 END) points_used, " +
        "SUM(CASE WHEN reason = 'refund' THEN delta ELSE 0 END) points_refunded " +
        'FROM mcp_points_ledger WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(created_at) ORDER BY day',
      [d]
    );
    const dailyRevenue = await this.q(
      "SELECT DATE(paid_at) day, SUM(amount_cents) cents, COUNT(*) orders FROM mcp_order WHERE status = 'paid' AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(paid_at) ORDER BY day",
      [d]
    );
    const bySku = await this.q(
      "SELECT sku, COUNT(*) orders, SUM(amount_cents) cents FROM mcp_order WHERE status = 'paid' AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY sku ORDER BY cents DESC",
      [d]
    );
    const topTools = await this.q(
      "SELECT ref tool, COUNT(*) calls, SUM(-delta) points FROM mcp_points_ledger WHERE reason = 'call' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY ref ORDER BY calls DESC LIMIT 20",
      [d]
    );
    const num = (v: any) => Number(v || 0);
    return {
      days: d,
      users: {
        total: num(users.total),
        paying: num(users.paying),
        pro: num(users.pro),
        pointsOutstanding: num(users.points_outstanding),
      },
      revenue: {
        windowCents: num(revenue.paid_cents),
        windowOrders: num(revenue.paid_orders),
        monthCents: num(revenueMonth.paid_cents),
        monthOrders: num(revenueMonth.paid_orders),
        pendingConfirm: num(pending.n),
        pendingCents: num(pending.cents),
        basis: '以管理员确认到账的订单为准；个人收款码无自动到账核验',
      },
      daily,
      dailyRevenue,
      bySku,
      topTools,
    };
  }
}
