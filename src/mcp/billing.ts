import { randomBytes } from 'crypto';
import { QueryFn } from './store';

/**
 * Journey 点计费：账户余额、会员档位、按次扣点、订单。
 *
 * 定价参照可灵（月卡/年卡 + 点数 + 加油包）。SKU 只写原价 listCents，实际售价由收费阶段决定
 * （owner 2026-10-31 定三阶段，见 PRICING_PHASES）：首月免费看数据 → 半价（页面展示原价）→ 正式价。
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
  /** 原价（分）。实际售价按收费阶段算，见 phasePrice() */
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
    listCents: 59900,
    desc: '每月 1200 点 × 12 个月 · 5 个 Key',
  },
  {
    sku: 'pack_100',
    name: '加油包 100 点',
    kind: 'pack',
    points: 100,
    listCents: 1000,
    desc: '一次性 100 点，不过期',
  },
  {
    sku: 'pack_500',
    name: '加油包 500 点',
    kind: 'pack',
    points: 500,
    listCents: 4500,
    desc: '一次性 500 点，不过期',
  },
  {
    sku: 'pack_1100',
    name: '加油包 1100 点',
    kind: 'pack',
    points: 1100,
    listCents: 8800,
    desc: '一次性 1100 点，不过期',
  },
];

export type PhaseId = 'free' | 'half' | 'full';

export interface PricingPhase {
  id: PhaseId;
  name: string;
  /** 北京时间 YYYY-MM-DD 零点起生效；null＝日期待定（还没到这一阶段） */
  from: string | null;
  note: string;
}

/**
 * 收费三阶段（owner 2026-10-31）：
 * 1. 首月免费：调用不扣点、不开放购买，重点看有没有人用（看板「用量」）；
 * 2. 半价：原价五折，页面同时展示原价；
 * 3. 正式价：按原价。日期等免费期数据出来后由 owner 定，填进 from 即可。
 */
export const PRICING_PHASES: PricingPhase[] = [
  {
    id: 'free',
    name: '公测免费',
    from: '2026-10-31',
    note: '公测首月免费：所有工具调用不扣点，无需购买。',
  },
  {
    id: 'half',
    name: '半价',
    from: '2026-12-01',
    note: '早期用户半价：按原价五折，已购会员在有效期内不受后续调价影响。',
  },
  {
    id: 'full',
    name: '正式价',
    from: null,
    note: '按原价收费。',
  },
];

/** 北京时间 YYYY-MM-DD 零点对应的时刻。 */
function bjMidnight(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00+08:00`);
}

/** 当前生效的阶段，以及下一阶段（日期已定的话）。 */
export function currentPhase(now = new Date()) {
  const t = now.getTime();
  let idx = 0;
  PRICING_PHASES.forEach((p, i) => {
    if (p.from && bjMidnight(p.from) <= t) idx = i;
  });
  const phase = PRICING_PHASES[idx];
  const next = PRICING_PHASES[idx + 1];
  return {
    ...phase,
    next:
      next && next.from
        ? { id: next.id, name: next.name, from: next.from }
        : null,
  };
}

/** 某阶段下的售价（分）。 */
export function phasePrice(
  sku: Pick<Sku, 'listCents'>,
  phase: PhaseId
): number {
  if (phase === 'free') return 0;
  if (phase === 'half') return Math.round(sku.listCents / 2);
  return sku.listCents;
}

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
  interview_topics: 3,
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

  /** amountCents 由调用方按当前阶段算好传入（phasePrice），订单落库的就是应付金额。 */
  async createOrder(userId: string, sku: Sku, amountCents: number) {
    await this.ensureSchema();
    // 同一用户同一商品已有未完成订单就复用，避免重复点出一堆待付款
    const open = await this.q(
      // 金额也要一致：跨阶段调价后不复用旧价格的待付款单
      "SELECT order_no, sku, amount_cents, status, created_at FROM mcp_order WHERE user_id = ? AND sku = ? AND amount_cents = ? AND status IN ('pending','self_reported') ORDER BY id DESC LIMIT 1",
      [userId, sku.sku, amountCents]
    );
    if (open?.[0]) return { ...open[0], reused: true };
    const orderNo = genOrderNo();
    await this.q(
      'INSERT INTO mcp_order (order_no, user_id, sku, amount_cents, list_cents) VALUES (?, ?, ?, ?, ?)',
      [orderNo, userId, sku.sku, amountCents, sku.listCents]
    );
    return {
      order_no: orderNo,
      sku: sku.sku,
      amount_cents: amountCents,
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
      // 失败调用会以 refund 退回同一工具的点数：calls 是扣点次数，failed 是退点次数，points 是净消耗
      "SELECT ref tool, SUM(reason = 'call') calls, SUM(reason = 'refund') failed, SUM(-delta) points FROM mcp_points_ledger WHERE reason IN ('call', 'refund') AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY ref ORDER BY calls DESC LIMIT 20",
      [d]
    );
    const num = (v: any) => Number(v || 0);
    const usage = await this.usageStats(d).catch(() => null);
    return {
      days: d,
      phase: currentPhase(),
      usage,
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

  /**
   * 用量看板（免费期的核心数据：有没有人用、用得多不多、回不回来）。
   * 只统计用户自助开的 Key（管理员手发的测试 Key 不算），数据来自调用日志，与是否扣点无关。
   * wouldBePoints＝成功调用按单价折算的点数，免费期用来估算付费后的消耗。
   */
  async usageStats(days = 30) {
    const d = Math.max(1, Math.min(180, Math.floor(days)));
    const from = 'l.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
    const base =
      'FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id WHERE k.user_id IS NOT NULL AND ' +
      from;
    const num = (v: any) => Number(v || 0);
    const [totals] = await this.q(
      'SELECT COUNT(*) calls, SUM(l.ok = 0) failed, COUNT(DISTINCT k.user_id) users ' +
        base,
      [d]
    );
    const [repeat] = await this.q(
      'SELECT COUNT(*) n FROM (SELECT k.user_id ' +
        base +
        ' GROUP BY k.user_id HAVING COUNT(DISTINCT DATE(l.created_at)) >= 2) t',
      [d]
    );
    const [accounts] = await this.q(
      'SELECT COUNT(*) total, SUM(created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) recent FROM mcp_account',
      [d]
    );
    const [everCalled] = await this.q(
      'SELECT COUNT(DISTINCT k.user_id) n FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id WHERE k.user_id IS NOT NULL'
    );
    const daily = await this.q(
      'SELECT DATE(l.created_at) day, COUNT(*) calls, SUM(l.ok = 0) failed, COUNT(DISTINCT k.user_id) users ' +
        base +
        ' GROUP BY DATE(l.created_at) ORDER BY day',
      [d]
    );
    const signups = await this.q(
      'SELECT DATE(created_at) day, COUNT(*) n FROM mcp_account WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(created_at) ORDER BY day',
      [d]
    );
    const tools = (
      await this.q(
        'SELECT l.product, l.tool, COUNT(*) calls, SUM(l.ok = 0) failed, COUNT(DISTINCT k.user_id) users ' +
          base +
          ' GROUP BY l.product, l.tool ORDER BY calls DESC LIMIT 30',
        [d]
      )
    ).map((r: any) => ({
      product: r.product,
      tool: r.tool,
      calls: num(r.calls),
      failed: num(r.failed),
      users: num(r.users),
      wouldBePoints: (num(r.calls) - num(r.failed)) * toolCost(r.tool),
    }));
    const topUsers = await this.q(
      'SELECT k.user_id, COUNT(*) calls, COUNT(DISTINCT DATE(l.created_at)) active_days, MAX(l.created_at) last_at ' +
        base +
        ' GROUP BY k.user_id ORDER BY calls DESC LIMIT 20',
      [d]
    );
    return {
      basis: '只统计用户自助开的 Key；管理员测试 Key 不计入',
      activeUsers: num(totals?.users),
      repeatUsers: num(repeat?.n),
      calls: num(totals?.calls),
      failed: num(totals?.failed),
      wouldBePoints: tools.reduce(
        (a: number, t: any) => a + t.wouldBePoints,
        0
      ),
      accounts: num(accounts?.total),
      newAccounts: num(accounts?.recent),
      everCalledUsers: num(everCalled?.n),
      daily: daily.map((r: any) => ({
        day: r.day,
        calls: num(r.calls),
        failed: num(r.failed),
        users: num(r.users),
      })),
      signups: signups.map((r: any) => ({ day: r.day, n: num(r.n) })),
      tools,
      topUsers: topUsers.map((r: any) => ({
        userId: r.user_id,
        calls: num(r.calls),
        activeDays: num(r.active_days),
        lastAt: r.last_at,
      })),
    };
  }
}
