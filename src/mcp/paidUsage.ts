import type { QueryFn } from './store';
import { errKind } from './usage';

/**
 * 付费用户视图（owner 2026-11-04：「看看付费用户是怎么用的，会员权益是否够用，是否有 bug，
 * 以及看看有没有什么新的机会」）。管理后台「开发者服务 › 付费用户」，接口 /mcp/admin/analytics/paid。
 *
 * 付费用户＝有真实到账订单的账户（排除 1 分钱测试单、管理员）。另外单列「有效会员但没有付费订单」
 * 的人数（赠送/手工开通），不混进画像。
 *
 * 四块：
 * 1. 怎么用：工具分布、时段、客户端、会话深度、工具连调路径、参数模式；
 * 2. 权益够不够：本期（最近一次发点起）消耗、按当前速度一个月用多少、多久用完、撞上限、买加油包；
 * 3. 有没有 bug：报错归类、超时/慢调用、失败退点、短时间同参数重复调用；
 * 4. 新机会：没结果的查询、客户端调了我们没有的工具/方法。
 *
 * 只读聚合，不写库。11-04 之前的调用没有参数/计费/结果字段，相关统计只覆盖之后的调用（返回里有 coverage）。
 */

const SESSION_GAP_MS = 30 * 60 * 1000;
const DUP_WINDOW_MS = 60 * 1000;
const DUP_WINDOW_NO_HASH_MS = 10 * 1000;
const SLOW_MS = 20 * 1000;
const DAY_MS = 86400000;

const num = (v: any) => Number(v || 0);

function ms(v: any): number {
  if (v instanceof Date) return v.getTime();
  return Date.parse(String(v).replace(' ', 'T'));
}

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, i)];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** 手机号打码（管理后台认人用，不出全号） */
export function maskPhone(p: any): string | null {
  const s = String(p || '');
  if (!s) return null;
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : '****';
}

interface CallRow {
  uid: string;
  product: string;
  tool: string;
  ok: number;
  latency_ms: number;
  cost: number;
  client: string | null;
  created_at: any;
  day: string;
  h: number;
  wd: number;
  billing: string | null;
  args: string | null;
  args_hash: string | null;
  result_items: number | null;
  err_kind: string | null;
  error: string | null;
}

/** 会话切分 + 重复调用 + 连调路径（纯函数，单测直接喂行）。rows 须按 uid、时间升序。 */
export function sessionize(
  rows: Pick<CallRow, 'uid' | 'tool' | 'created_at' | 'args_hash'>[]
) {
  const sessions: {
    uid: string;
    n: number;
    tools: Set<string>;
    start: number;
    end: number;
  }[] = [];
  const pairs = new Map<string, number>();
  const dupByTool = new Map<string, number>();
  let dup = 0;
  let prev: (typeof rows)[number] | null = null;
  let prevT = 0;
  let cur: (typeof sessions)[number] | null = null;
  for (const r of rows) {
    const t = ms(r.created_at);
    const sameUser = prev && prev.uid === r.uid;
    if (!sameUser || t - prevT > SESSION_GAP_MS || !cur) {
      cur = { uid: r.uid, n: 0, tools: new Set(), start: t, end: t };
      sessions.push(cur);
    } else if (prev) {
      const gap = t - prevT;
      const isDup =
        prev.tool === r.tool &&
        (r.args_hash && prev.args_hash
          ? r.args_hash === prev.args_hash && gap <= DUP_WINDOW_MS
          : gap <= DUP_WINDOW_NO_HASH_MS);
      if (isDup) {
        dup++;
        dupByTool.set(r.tool, (dupByTool.get(r.tool) || 0) + 1);
      } else {
        const k = `${prev.tool}→${r.tool}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    }
    cur.n++;
    cur.tools.add(r.tool);
    cur.end = t;
    prev = r;
    prevT = t;
  }
  const sizes = sessions.map(s => s.n);
  return {
    sessions,
    summary: {
      count: sessions.length,
      medianCalls: pct(sizes, 50),
      p90Calls: pct(sizes, 90),
      maxCalls: sizes.length ? Math.max(...sizes) : null,
      medianMinutes: sessions.length
        ? round1(
            pct(
              sessions.map(s => (s.end - s.start) / 60000),
              50
            )!
          )
        : null,
      medianTools: pct(
        sessions.map(s => s.tools.size),
        50
      ),
    },
    duplicates: {
      n: dup,
      rate: rows.length ? round1((dup / rows.length) * 100) : 0,
      byTool: [...dupByTool.entries()]
        .map(([tool, n]) => ({ tool, n }))
        .sort((a, b) => b.n - a.n),
    },
    paths: [...pairs.entries()]
      .map(([path, n]) => ({ path, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12),
  };
}

/**
 * 权益够不够（单个会员）：本期已用 / 本期天数 × 30 ＝ 按当前速度一个月用多少点；
 * 余额 ÷ 日均 ＝ 还能用几天。本期不足 1 天按 1 天算（刚开通当天的速度会偏高，看板注明）。
 */
export function entitlement(p: {
  usedCycle: number;
  cycleStartMs: number;
  nowMs: number;
  monthly: number;
  balance: number;
}) {
  const days = Math.max(1, (p.nowMs - p.cycleStartMs) / DAY_MS);
  const perDay = p.usedCycle / days;
  const monthPace = Math.round(perDay * 30);
  return {
    cycleDays: round1(days),
    perDay: round1(perDay),
    monthPace,
    pacePct: p.monthly ? Math.round((monthPace / p.monthly) * 100) : null,
    daysLeft: perDay > 0 ? round1(p.balance / perDay) : null,
  };
}

export async function paidUsage(q: QueryFn, days = 30, nowMs = Date.now()) {
  const d = Math.max(1, Math.min(180, Math.floor(days)));
  const payers: any[] =
    (await q(
      'SELECT m.user_id, MIN(m.paid_at) first_paid, MAX(m.paid_at) last_paid, COUNT(*) orders, ' +
        "SUM(m.amount_cents) cents, GROUP_CONCAT(DISTINCT m.sku) skus, SUM(m.sku LIKE 'pack%') packs, " +
        'MAX(u.phoneNumber) phone FROM mcp_order m LEFT JOIN `user` u ON u.id = m.user_id ' +
        "WHERE m.status = 'paid' AND m.sku <> 'pay_test' AND (u.role IS NULL OR u.role <> 'admin') " +
        'GROUP BY m.user_id ORDER BY first_paid'
    )) || [];
  const [grantedRow] =
    (await q(
      "SELECT COUNT(*) n FROM mcp_account a WHERE a.tier IN ('member','starter','pro') AND a.tier_expire_at > NOW() " +
        "AND a.user_id NOT IN (SELECT user_id FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test')"
    )) || [];
  const ids = payers.map(r => String(r.user_id));
  const base = {
    days: d,
    basis:
      '付费用户＝有真实到账订单的账户（不含 1 分钱测试单、管理员）；「本期」＝最近一次会员发点起',
    payers: ids.length,
    grantedMembers: num(grantedRow?.n),
  };
  if (!ids.length) return { ...base, users: [], empty: true };

  const ph = ids.map(() => '?').join(',');
  const win = 'DATE_SUB(NOW(), INTERVAL ? DAY)';

  // ── 账户与点数 ──
  const accts: any[] =
    (await q(
      'SELECT user_id, points, tier, tier_expire_at, monthly_points, ' +
        '(tier_expire_at IS NOT NULL AND tier_expire_at > NOW()) active FROM mcp_account ' +
        `WHERE user_id IN (${ph})`,
      ids
    )) || [];
  const acct = new Map(accts.map(a => [String(a.user_id), a]));
  const grants: any[] =
    (await q(
      "SELECT user_id, MAX(created_at) at FROM mcp_points_ledger WHERE reason = 'plan_grant' " +
        `AND user_id IN (${ph}) GROUP BY user_id`,
      ids
    )) || [];
  const cycleStart = new Map<string, number>(
    grants.map(g => [String(g.user_id), ms(g.at)])
  );
  for (const p of payers) {
    const u = String(p.user_id);
    if (!cycleStart.has(u)) cycleStart.set(u, ms(p.first_paid));
  }
  const ledger: any[] =
    (await q(
      'SELECT user_id, ref, reason, delta, created_at FROM mcp_points_ledger ' +
        `WHERE user_id IN (${ph}) AND reason IN ('call','refund') AND created_at >= DATE_SUB(NOW(), INTERVAL 400 DAY)`,
      ids
    )) || [];
  const cyc = new Map<
    string,
    { used: number; skill: number; iris: number; refunds: number }
  >();
  for (const r of ledger) {
    const u = String(r.user_id);
    if (ms(r.created_at) < (cycleStart.get(u) || 0)) continue;
    const c = cyc.get(u) || { used: 0, skill: 0, iris: 0, refunds: 0 };
    const pts = -num(r.delta); // call 为正消耗，refund 为负
    c.used += pts;
    if (String(r.ref || '').startsWith('iris')) c.iris += pts;
    else c.skill += pts;
    if (r.reason === 'refund') c.refunds++;
    cyc.set(u, c);
  }

  // ── 接入程度与事件 ──
  const keys: any[] =
    (await q(
      'SELECT user_id, COUNT(*) n, SUM(connected_at IS NOT NULL) connected FROM mcp_api_key ' +
        `WHERE user_id IN (${ph}) GROUP BY user_id`,
      ids
    )) || [];
  const keyOf = new Map(keys.map(k => [String(k.user_id), k]));
  const evs: any[] =
    (await q(
      'SELECT user_id, event, COUNT(*) n FROM mcp_event ' +
        `WHERE user_id IN (${ph}) AND created_at >= ${win} ` +
        "AND event IN ('credit_low','credit_exhausted','quota_exceeded','auth_failed') GROUP BY user_id, event",
      [...ids, d]
    )) || [];
  const evOf = new Map<string, Record<string, number>>();
  for (const e of evs) {
    const u = String(e.user_id);
    const m = evOf.get(u) || {};
    m[e.event] = num(e.n);
    evOf.set(u, m);
  }

  // ── 调用明细（窗口内） ──
  const rows: CallRow[] =
    (await q(
      'SELECT COALESCE(l.user_id, k.user_id) uid, l.product, l.tool, l.ok, l.latency_ms, l.cost, l.client, ' +
        "l.created_at, DATE_FORMAT(l.created_at, '%Y-%m-%d') day, HOUR(l.created_at) h, WEEKDAY(l.created_at) wd, l.billing, l.args, l.args_hash, " +
        'l.result_items, l.err_kind, LEFT(l.error, 100) error FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id ' +
        `WHERE k.user_id IN (${ph}) AND l.created_at >= ${win} ORDER BY uid, l.created_at, l.id LIMIT 50000`,
      [...ids, d]
    )) || [];
  for (const r of rows) r.uid = String(r.uid);

  const perUser = new Map<
    string,
    {
      calls: number;
      failed: number;
      days: Set<string>;
      tools: Set<string>;
      last: number;
      byDay: Map<string, number>;
    }
  >();
  const tools = new Map<
    string,
    {
      product: string;
      tool: string;
      calls: number;
      failed: number;
      users: Set<string>;
      lat: number[];
      points: number;
      withItems: number;
      empty: number;
    }
  >();
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const clients = new Map<string, { n: number; users: Set<string> }>();
  const billingMix: Record<string, number> = {};
  const errKinds = new Map<string, number>();
  const errMsgs = new Map<
    string,
    { tool: string; error: string; kind: string; n: number }
  >();
  const argPatterns = new Map<
    string,
    { tool: string; args: string; n: number; users: Set<string> }
  >();
  const emptyQueries = new Map<
    string,
    { tool: string; args: string; n: number; users: Set<string> }
  >();
  let slow = 0;
  let withMeta = 0;
  for (const r of rows) {
    const u = r.uid;
    const day = String(r.day || '').slice(0, 10);
    const pu = perUser.get(u) || {
      calls: 0,
      failed: 0,
      days: new Set(),
      tools: new Set(),
      last: 0,
      byDay: new Map(),
    };
    pu.calls++;
    if (num(r.ok) !== 1) pu.failed++;
    pu.days.add(day);
    pu.tools.add(r.tool);
    pu.last = Math.max(pu.last, ms(r.created_at));
    pu.byDay.set(day, (pu.byDay.get(day) || 0) + 1);
    perUser.set(u, pu);

    const tk = `${r.product}/${r.tool}`;
    const t = tools.get(tk) || {
      product: r.product,
      tool: r.tool,
      calls: 0,
      failed: 0,
      users: new Set(),
      lat: [],
      points: 0,
      withItems: 0,
      empty: 0,
    };
    t.calls++;
    if (num(r.ok) !== 1) t.failed++;
    t.users.add(u);
    t.lat.push(num(r.latency_ms));
    t.points += num(r.cost);
    if (r.result_items !== null && r.result_items !== undefined) {
      t.withItems++;
      if (num(r.result_items) === 0) t.empty++;
    }
    tools.set(tk, t);

    hours[num(r.h) % 24]++;
    weekdays[num(r.wd) % 7]++;
    const c = r.client || '未知';
    const ce = clients.get(c) || { n: 0, users: new Set() };
    ce.n++;
    ce.users.add(u);
    clients.set(c, ce);
    if (num(r.latency_ms) >= SLOW_MS) slow++;
    if (r.billing) {
      withMeta++;
      billingMix[r.billing] = (billingMix[r.billing] || 0) + 1;
    }
    if (num(r.ok) !== 1) {
      const kind = r.err_kind || errKind(r.error) || 'other';
      errKinds.set(kind, (errKinds.get(kind) || 0) + 1);
      const mk = `${r.tool}|${r.error || ''}`;
      const m = errMsgs.get(mk) || {
        tool: r.tool,
        error: r.error || '',
        kind,
        n: 0,
      };
      m.n++;
      errMsgs.set(mk, m);
    }
    if (r.args) {
      const ak = `${r.tool}|${r.args}`;
      const a = argPatterns.get(ak) || {
        tool: r.tool,
        args: r.args,
        n: 0,
        users: new Set(),
      };
      a.n++;
      a.users.add(u);
      argPatterns.set(ak, a);
      if (
        num(r.ok) === 1 &&
        r.result_items !== null &&
        num(r.result_items) === 0
      ) {
        const e = emptyQueries.get(ak) || {
          tool: r.tool,
          args: r.args,
          n: 0,
          users: new Set(),
        };
        e.n++;
        e.users.add(u);
        emptyQueries.set(ak, e);
      }
    }
  }
  const sess = sessionize(rows);

  // 客户端握手名（Claude Code / Cursor / Codex …）
  const inits: any[] =
    (await q(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.clientName')) c, COUNT(*) n, COUNT(DISTINCT user_id) users FROM mcp_event " +
        `WHERE event = 'mcp_initialize' AND user_id IN (${ph}) AND created_at >= ${win} GROUP BY c ORDER BY n DESC LIMIT 15`,
      [...ids, d]
    )) || [];
  // 新机会：客户端调了我们没有的工具 / 方法（全体用户，样本太少只看付费用户没意义）
  const unknown: any[] =
    (await q(
      "SELECT event, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(props, '$.name')), JSON_UNQUOTE(JSON_EXTRACT(props, '$.method'))) label, " +
        'COUNT(*) n, COUNT(DISTINCT user_id) users FROM mcp_event ' +
        `WHERE event IN ('tool_unknown','method_unsupported') AND created_at >= ${win} GROUP BY event, label ORDER BY n DESC LIMIT 20`,
      [d]
    )) || [];
  // 对照：全体自助用户
  const [all] =
    (await q(
      'SELECT COUNT(DISTINCT k.user_id) users, COUNT(*) calls FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id ' +
        `WHERE k.user_id IS NOT NULL AND l.created_at >= ${win}`,
      [d]
    )) || [];

  const users = payers.map(p => {
    const u = String(p.user_id);
    const a = acct.get(u) || {};
    const c = cyc.get(u) || { used: 0, skill: 0, iris: 0, refunds: 0 };
    const pu = perUser.get(u);
    const k = keyOf.get(u);
    const ev = evOf.get(u) || {};
    const ent = entitlement({
      usedCycle: c.used,
      cycleStartMs: cycleStart.get(u) || nowMs,
      nowMs,
      monthly: num(a.monthly_points),
      balance: num(a.points),
    });
    return {
      userId: u,
      phone: maskPhone(p.phone),
      skus: String(p.skus || '')
        .split(',')
        .filter(Boolean),
      orders: num(p.orders),
      cents: num(p.cents),
      packs: num(p.packs),
      firstPaid: p.first_paid,
      member: num(a.active) === 1,
      expireAt: a.tier_expire_at || null,
      balance: num(a.points),
      monthly: num(a.monthly_points),
      cycleStart: cycleStart.get(u)
        ? new Date(cycleStart.get(u)!).toISOString()
        : null,
      usedCycle: c.used,
      skillPts: c.skill,
      irisPts: c.iris,
      refunds: c.refunds,
      ...ent,
      keys: num(k?.n),
      connected: num(k?.connected) > 0,
      calls: pu?.calls || 0,
      failed: pu?.failed || 0,
      activeDays: pu?.days.size || 0,
      tools: pu ? [...pu.tools] : [],
      maxDailyCalls: pu ? Math.max(...pu.byDay.values()) : 0,
      lastCallAt: pu?.last ? new Date(pu.last).toISOString() : null,
      sessions: sess.sessions.filter(s => s.uid === u).length,
      creditLow: ev.credit_low || 0,
      exhausted: ev.credit_exhausted || 0,
      quotaHits: ev.quota_exceeded || 0,
      authFailed: ev.auth_failed || 0,
    };
  });

  const members = users.filter(u => u.member && u.monthly > 0);
  const paces = members
    .map(u => u.pacePct)
    .filter((x): x is number => x !== null);
  const usedSkill = users.reduce((s, u) => s + u.skillPts, 0);
  const usedIris = users.reduce((s, u) => s + u.irisPts, 0);
  const activePaid = users.filter(u => u.calls > 0).length;

  return {
    ...base,
    coverage: {
      calls: rows.length,
      withMeta,
      note: '参数摘要、计费口径、结果条数从 2026-11-04 起记录；更早的调用只有工具、成败、耗时、客户端',
    },
    adoption: {
      payers: users.length,
      withKey: users.filter(u => u.keys > 0).length,
      connected: users.filter(u => u.connected).length,
      calledInWindow: activePaid,
      usedIris: users.filter(u => u.irisPts > 0).length,
    },
    entitlement: {
      members: members.length,
      medianPacePct: pct(paces, 50),
      over80: paces.filter(x => x >= 80).length,
      over100: paces.filter(x => x >= 100).length,
      exhaustedUsers: users.filter(u => u.exhausted > 0).length,
      quotaHitUsers: users.filter(u => u.quotaHits > 0).length,
      packBuyers: users.filter(u => u.packs > 0).length,
      maxDailyCalls: Math.max(0, ...users.map(u => u.maxDailyCalls)),
      dailyLimit: 1500,
      pointsSkill: usedSkill,
      pointsIris: usedIris,
    },
    compare: {
      paidActive: activePaid,
      paidCallsPerActive: activePaid ? round1(rows.length / activePaid) : null,
      allActive: num(all?.users),
      allCallsPerActive: num(all?.users)
        ? round1(num(all?.calls) / num(all?.users))
        : null,
    },
    tools: [...tools.values()]
      .map(t => ({
        product: t.product,
        tool: t.tool,
        calls: t.calls,
        users: t.users.size,
        failed: t.failed,
        errorRate: t.calls ? round1((t.failed / t.calls) * 100) : 0,
        p50: pct(t.lat, 50),
        p95: pct(t.lat, 95),
        points: t.points,
        emptyRate: t.withItems ? round1((t.empty / t.withItems) * 100) : null,
      }))
      .sort((a, b) => b.calls - a.calls),
    hours,
    weekdays,
    clients: [...clients.entries()]
      .map(([client, v]) => ({ client, calls: v.n, users: v.users.size }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 12),
    clientNames: inits.map(r => ({
      client: r.c || '未知',
      sessions: num(r.n),
      users: num(r.users),
    })),
    sessions: sess.summary,
    paths: sess.paths,
    duplicates: sess.duplicates,
    bugs: {
      errorKinds: [...errKinds.entries()]
        .map(([kind, n]) => ({ kind, n }))
        .sort((a, b) => b.n - a.n),
      topErrors: [...errMsgs.values()].sort((a, b) => b.n - a.n).slice(0, 12),
      slowCalls: slow,
      slowMs: SLOW_MS,
      refunded: billingMix.refunded || 0,
    },
    billingMix,
    argPatterns: [...argPatterns.values()]
      .map(a => ({ tool: a.tool, args: a.args, n: a.n, users: a.users.size }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15),
    emptyQueries: [...emptyQueries.values()]
      .map(a => ({ tool: a.tool, args: a.args, n: a.n, users: a.users.size }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15),
    unknown: unknown.map(r => ({
      event: r.event,
      label: r.label || '?',
      n: num(r.n),
      users: num(r.users),
    })),
    users,
  };
}
