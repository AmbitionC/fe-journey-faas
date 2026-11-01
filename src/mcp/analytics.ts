import type { QueryFn } from './store';

/**
 * 两个 Skill（Agent Journey / Invest Journey）的全链路埋点（owner 2026-11-01：
 * 「做好全方位数据埋点，方便以后优化」）。
 *
 * 一张事件表 mcp_event 收两类事件：
 * - server：后端在关键节点直接记（开通、建 Key、MCP 握手、额度/点数耗尽、下单、付款、到账……），
 *   这些是计费与转化的真相源，前端漏发也不影响；
 * - web：两个 Skill 页（agent-journey.cn/developer、Invest Journey /skills）经 POST /mcp/track 上报
 *   的浏览与交互（访问、切换安装方式、复制命令、点按钮、展开 FAQ）。
 *
 * 每次工具调用仍记在 mcp_call_log（量大，单独一张表），本次给它补了 cost / client 两列。
 *
 * 埋点一律「失败不影响业务」：track() 自己吞掉所有异常。
 */

export type EventSource = 'server' | 'web';

export interface TrackInput {
  event: string;
  source?: EventSource;
  userId?: string | null;
  keyId?: number | null;
  product?: string | null;
  anonId?: string | null;
  page?: string | null;
  props?: Record<string, any> | null;
}

/**
 * 后端事件名（字段约定写在这里，看板与计费线程共用，改名要两边一起改）。
 * props 字段：
 * - trial_granted        { points }
 * - account_activated    { created, via: 'activate'|'order' }
 * - key_created          { tier, activeKeys }
 * - key_revoked          { keyId }
 * - mcp_initialize       { clientName, clientVersion, protocolVersion, via }
 * - auth_failed          { reason: 'missing'|'invalid'|'scope', via }
 * - quota_exceeded       { tool, limit, tier }
 * - credit_exhausted     { tool, cost, balance, tier, phase }
 * - order_created        { orderNo, sku, amountCents, listCents, phase, reused }
 * - pay_link_issued      { orderNo, channel: 'alipay' }
 * - order_reported       { orderNo }
 * - order_paid           { orderNo, sku, amountCents, channel: 'alipay'|'manual'|'auto' }
 * - order_rejected       { orderNo }
 */
export const SERVER_EVENTS = [
  'trial_granted',
  'account_activated',
  'key_created',
  'key_revoked',
  'mcp_initialize',
  'auth_failed',
  'quota_exceeded',
  'credit_exhausted',
  'order_created',
  'pay_link_issued',
  'order_reported',
  'order_paid',
  'order_rejected',
] as const;

/**
 * 前端可上报的事件（白名单，防止任意写库）。props 里常用 label（点了什么）、client（安装方式）、
 * section、utm_*、referrer。
 */
export const WEB_EVENTS = [
  'page_view', // 进入 Skill 页 { referrer, utm_source, utm_medium, utm_campaign, loggedIn }
  'section_view', // 滚到某一屏 { section }
  'install_select', // 切换安装方式 { client }
  'copy_click', // 复制命令 / 配置 / Key { label, client }
  'cta_click', // 点按钮（开通、建 Key、购买、登录……） { label, sku }
  'faq_open', // 展开 FAQ { label }
  'pricing_view', // 看到价目 { phase }
  'pay_return', // 从支付宝跳回 { orderNo, paid }
  'error_shown', // 页面上给用户看到的报错 { label, message }
] as const;

/** Skill 页 → 产品（漏斗按产品拆分用） */
export const PAGE_PRODUCT: Record<string, 'agent' | 'invest'> = {
  agent_developer: 'agent',
  invest_skills: 'invest',
};

const MAX_BATCH = 30;
const MAX_PROPS_CHARS = 2000;
const ANON_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** props 只留可序列化的浅层字段，字符串截断，整体不超过 2000 字符。 */
export function cleanProps(p: any): Record<string, any> | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(p).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  let s = JSON.stringify(out);
  if (s.length > MAX_PROPS_CHARS) s = '{}';
  return s === '{}' ? null : JSON.parse(s);
}

/** 客户端标识：Skill 插件在 .mcp.json 里带 X-Journey-Client；没有就取 User-Agent 首段。 */
export function clientOf(headers: Record<string, any>): string | null {
  const explicit = String(headers['x-journey-client'] || '').trim();
  if (explicit) return explicit.slice(0, 64);
  const ua = String(headers['user-agent'] || '').trim();
  if (!ua) return null;
  return ua.split(/\s+/)[0].slice(0, 64);
}

export interface WebBatch {
  anonId?: string;
  events?: { event?: string; page?: string; props?: any }[];
}

/** 校验前端上报批次，返回可入库的事件（非法项直接丢弃，不报错）。 */
export function sanitizeWebBatch(
  batch: WebBatch,
  userId: string | null
): TrackInput[] {
  const anonId =
    typeof batch?.anonId === 'string' && ANON_RE.test(batch.anonId)
      ? batch.anonId
      : null;
  const list = Array.isArray(batch?.events) ? batch.events : [];
  const out: TrackInput[] = [];
  for (const e of list.slice(0, MAX_BATCH)) {
    if (!e || !(WEB_EVENTS as readonly string[]).includes(String(e.event)))
      continue;
    const page = typeof e.page === 'string' ? e.page.slice(0, 32) : null;
    if (!page || !PAGE_PRODUCT[page]) continue;
    out.push({
      event: String(e.event),
      source: 'web',
      userId,
      anonId,
      page,
      product: PAGE_PRODUCT[page],
      props: cleanProps(e.props),
    });
  }
  return out;
}

/** 记一条埋点；永不抛错，运行时没装配埋点（单测）时跳过。 */
export async function track(
  rt: { analytics?: Analytics | null },
  e: TrackInput
): Promise<void> {
  if (!rt.analytics) return;
  try {
    await rt.analytics.track(e);
  } catch {
    /* 埋点失败不影响业务 */
  }
}

const num = (v: any) => Number(v || 0);

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, i)];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return pct(s, 50);
}

/** 'YYYY-MM-DD…' / Date → 毫秒 */
function ms(v: any): number {
  if (v instanceof Date) return v.getTime();
  return Date.parse(String(v).replace(' ', 'T'));
}

export class Analytics {
  private schemaReady: Promise<void> | null = null;

  constructor(private q: QueryFn) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_event (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          event VARCHAR(40) NOT NULL,
          source VARCHAR(8) NOT NULL DEFAULT 'server',
          user_id VARCHAR(64) NULL,
          key_id INT NULL,
          product VARCHAR(16) NULL,
          anon_id VARCHAR(64) NULL,
          page VARCHAR(32) NULL,
          props TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_mcp_event_name_time (event, created_at),
          KEY idx_mcp_event_user (user_id, created_at),
          KEY idx_mcp_event_anon (anon_id, created_at),
          KEY idx_mcp_event_time (created_at)
        ) DEFAULT CHARSET=utf8mb4`);
      })().catch(e => {
        this.schemaReady = null;
        throw e;
      });
    }
    return this.schemaReady;
  }

  /** 记一条事件；永不抛错（埋点失败不能拖垮调用、下单、付款）。 */
  async track(e: TrackInput): Promise<void> {
    try {
      await this.ensureSchema();
      const props = e.props ? JSON.stringify(e.props).slice(0, 4000) : null;
      await this.q(
        'INSERT INTO mcp_event (event, source, user_id, key_id, product, anon_id, page, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          e.event.slice(0, 40),
          e.source || 'server',
          e.userId || null,
          e.keyId ?? null,
          e.product || null,
          e.anonId || null,
          e.page || null,
          props,
        ]
      );
    } catch (err: any) {
      console.error('[mcp] 埋点写入失败', e.event, err?.message);
    }
  }

  async trackMany(list: TrackInput[]): Promise<number> {
    if (!list.length) return 0;
    try {
      await this.ensureSchema();
      const rows = list.map(e => [
        e.event.slice(0, 40),
        e.source || 'server',
        e.userId || null,
        e.keyId ?? null,
        e.product || null,
        e.anonId || null,
        e.page || null,
        e.props ? JSON.stringify(e.props).slice(0, 4000) : null,
      ]);
      await this.q(
        'INSERT INTO mcp_event (event, source, user_id, key_id, product, anon_id, page, props) VALUES ' +
          rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', '),
        rows.flat()
      );
      return rows.length;
    } catch (err: any) {
      console.error('[mcp] 埋点批量写入失败', err?.message);
      return 0;
    }
  }

  /**
   * 运营看板「漏斗与留存」（管理后台 → 开发者服务 → 用量）。
   *
   * 口径：
   * - 页面两步（访客、有安装意向）按匿名访客 anon_id 去重，是窗口内人数；
   * - 用户各步按「窗口内新开通的账户」这一批人往下追（真漏斗，同一批人），
   *   只算自助开通的用户，管理员手发的测试 Key 不在其中；
   * - product=agent/invest 时，页面步只看该产品的页面，「调用」类步只看该产品的调用；
   *   账户、Key、点数、订单两个产品共用，不拆。
   */
  async dashboard(days = 30, product: 'agent' | 'invest' | null = null) {
    await this.ensureSchema();
    const d = Math.max(1, Math.min(180, Math.floor(days)));
    const win = 'created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
    const pf = product ? ' AND product = ?' : '';
    const pp = product ? [product] : [];
    const one = async (sql: string, params: any[] = []) =>
      (await this.q(sql, params))?.[0] || {};

    // ── 页面 ──
    const web = await one(
      'SELECT COUNT(DISTINCT CASE WHEN event = ? THEN anon_id END) visitors, ' +
        "COUNT(DISTINCT CASE WHEN event IN ('install_select','copy_click') THEN anon_id END) installIntent, " +
        'COUNT(DISTINCT CASE WHEN user_id IS NOT NULL THEN user_id END) loggedIn ' +
        `FROM mcp_event WHERE source = 'web' AND ${win}${pf}`,
      ['page_view', d, ...pp]
    );

    // ── 用户漏斗（窗口内开通的这批人） ──
    const cohort: { user_id: string; created_at: any }[] = await this.q(
      `SELECT user_id, created_at FROM mcp_account WHERE ${win}`,
      [d]
    );
    const ids = cohort.map(r => String(r.user_id));
    const inList = (col: string) =>
      ids.length ? `${col} IN (${ids.map(() => '?').join(',')})` : '1 = 0';
    const callPf = product ? ' AND l.product = ?' : '';
    const userSet = async (sql: string, params: any[]) =>
      new Set<string>(
        ((await this.q(sql, params)) || []).map((r: any) => String(r.user_id))
      );

    const withKey = await userSet(
      `SELECT DISTINCT user_id FROM mcp_api_key WHERE ${inList('user_id')}`,
      ids
    );
    const callRows: { user_id: string; day: any; first_at: any }[] = ids.length
      ? await this.q(
          'SELECT k.user_id, DATE(l.created_at) day, MIN(l.created_at) first_at FROM mcp_call_log l ' +
            `JOIN mcp_api_key k ON k.id = l.key_id WHERE ${inList(
              'k.user_id'
            )} AND l.ok = 1${callPf} GROUP BY k.user_id, DATE(l.created_at)`,
          [...ids, ...pp]
        )
      : [];
    const daysByUser = new Map<string, Set<string>>();
    const firstCallAt = new Map<string, number>();
    for (const r of callRows) {
      const u = String(r.user_id);
      if (!daysByUser.has(u)) daysByUser.set(u, new Set());
      daysByUser.get(u)!.add(String(r.day).slice(0, 10));
      const t = ms(r.first_at);
      if (!firstCallAt.has(u) || t < firstCallAt.get(u)!) firstCallAt.set(u, t);
    }
    const connected = await userSet(
      `SELECT DISTINCT user_id FROM mcp_event WHERE event = 'mcp_initialize' AND ${inList(
        'user_id'
      )}${pf}`,
      [...ids, ...pp]
    );
    const exhausted = await userSet(
      `SELECT DISTINCT user_id FROM mcp_event WHERE event IN ('credit_exhausted','quota_exceeded') AND ${inList(
        'user_id'
      )}`,
      ids
    );
    const ordered = await userSet(
      `SELECT DISTINCT user_id FROM mcp_order WHERE sku <> 'pay_test' AND ${inList(
        'user_id'
      )}`,
      ids
    );
    const paid = await userSet(
      `SELECT DISTINCT user_id FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test' AND ${inList(
        'user_id'
      )}`,
      ids
    );
    const called = new Set(daysByUser.keys());
    const repeat = [...daysByUser.entries()].filter(([, s]) => s.size >= 2);

    const createdAt = new Map(
      cohort.map(r => [String(r.user_id), ms(r.created_at)])
    );
    const hoursToFirstCall = [...firstCallAt.entries()]
      .map(([u, t]) => (t - (createdAt.get(u) || t)) / 3600000)
      .filter(h => h >= 0);

    const funnel = [
      {
        step: 'visit',
        label: '访问 Skill 页',
        n: num(web.visitors),
        basis: 'anon',
      },
      {
        step: 'install_intent',
        label: '看安装方式/复制命令',
        n: num(web.installIntent),
        basis: 'anon',
      },
      {
        step: 'activated',
        label: '开通（领体验点）',
        n: ids.length,
        basis: 'cohort',
      },
      { step: 'key', label: '创建 Key', n: withKey.size, basis: 'cohort' },
      {
        step: 'connected',
        label: '客户端连上（MCP 握手）',
        n: connected.size,
        basis: 'cohort',
      },
      {
        step: 'first_call',
        label: '成功调用过工具',
        n: called.size,
        basis: 'cohort',
      },
      {
        step: 'repeat',
        label: '≥2 天有调用',
        n: repeat.length,
        basis: 'cohort',
      },
      {
        step: 'exhausted',
        label: '用完点数/额度',
        n: exhausted.size,
        basis: 'cohort',
      },
      { step: 'ordered', label: '下单', n: ordered.size, basis: 'cohort' },
      { step: 'paid', label: '付款成功', n: paid.size, basis: 'cohort' },
    ];

    return {
      days: d,
      product,
      basis:
        '页面两步按匿名访客去重；之后各步是「窗口内开通的这批用户」往下追的同一批人（只算自助开通的用户）',
      funnel,
      activation: {
        medianHoursToFirstCall: hoursToFirstCall.length
          ? Math.round(median(hoursToFirstCall)! * 10) / 10
          : null,
        loggedInVisitors: num(web.loggedIn),
      },
      retention: await this.retention(8, product),
      credit: await this.creditStats(d),
      tools: await this.toolPerf(d, product),
      clients: await this.clients(d, product),
      sources: await this.sources(d, product),
      interactions: await this.interactions(d, product),
      payments: await this.payments(d),
      errors: await this.errors(d, product),
      daily: await this.dailyEvents(d, product),
    };
  }

  /** 周留存：按开通周分批，看第 0~4 周各有多少人有成功调用。 */
  async retention(weeks = 8, product: string | null = null) {
    const w = Math.max(1, Math.min(26, weeks));
    const accts: { user_id: string; created_at: any }[] = await this.q(
      'SELECT user_id, created_at FROM mcp_account WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? WEEK)',
      [w]
    );
    if (!accts.length) return { weeks: w, cohorts: [] as any[] };
    const ids = accts.map(a => String(a.user_id));
    const rows: { user_id: string; day: any }[] = await this.q(
      'SELECT DISTINCT k.user_id, DATE(l.created_at) day FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id ' +
        `WHERE l.ok = 1 AND k.user_id IN (${ids.map(() => '?').join(',')})${
          product ? ' AND l.product = ?' : ''
        }`,
      product ? [...ids, product] : ids
    );
    const active = new Map<string, number[]>();
    for (const r of rows) {
      const u = String(r.user_id);
      if (!active.has(u)) active.set(u, []);
      active.get(u)!.push(ms(String(r.day).slice(0, 10) + 'T12:00:00'));
    }
    const WEEK = 7 * 86400000;
    const now = Date.now();
    const byCohort = new Map<string, { start: number; users: string[] }>();
    for (const a of accts) {
      const t = ms(a.created_at);
      // 周一为一周起点
      const dt = new Date(t);
      const dow = (dt.getDay() + 6) % 7;
      const monday = new Date(
        dt.getFullYear(),
        dt.getMonth(),
        dt.getDate() - dow
      );
      const key = monday.toISOString().slice(0, 10);
      if (!byCohort.has(key))
        byCohort.set(key, { start: monday.getTime(), users: [] });
      byCohort.get(key)!.users.push(String(a.user_id));
    }
    const created = new Map(
      accts.map(a => [String(a.user_id), ms(a.created_at)])
    );
    const cohorts = [...byCohort.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([week, c]) => {
        const counts = [0, 1, 2, 3, 4].map(k => {
          // 第 k 周还没到（或没过完）的，标 null
          if (c.start + k * WEEK > now) return null;
          return c.users.filter(u =>
            (active.get(u) || []).some(t => {
              const off = Math.floor((t - created.get(u)!) / WEEK);
              return off === k;
            })
          ).length;
        });
        return { week, size: c.users.length, active: counts };
      });
    return { weeks: w, cohorts };
  }

  /** 点数：谁用完了、多久用完、用完后有没有买。 */
  async creditStats(d: number) {
    const ex: { user_id: string; at: any; tool: string | null }[] =
      await this.q(
        "SELECT user_id, MIN(created_at) at, MAX(JSON_UNQUOTE(JSON_EXTRACT(props, '$.tool'))) tool FROM mcp_event " +
          "WHERE event = 'credit_exhausted' AND user_id IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY user_id",
        [d]
      );
    const [evt] = await this.q(
      "SELECT SUM(event = 'credit_exhausted') exhausted, SUM(event = 'quota_exceeded') quota, " +
        "COUNT(DISTINCT CASE WHEN event = 'quota_exceeded' THEN user_id END) quotaUsers " +
        'FROM mcp_event WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)',
      [d]
    );
    let hours: number[] = [];
    let orderedAfter = 0;
    let paidAfter = 0;
    if (ex.length) {
      const ids = ex.map(r => String(r.user_id));
      const ph = ids.map(() => '?').join(',');
      const accts = await this.q(
        `SELECT user_id, created_at FROM mcp_account WHERE user_id IN (${ph})`,
        ids
      );
      const created = new Map<string, number>(
        accts.map((a: any) => [String(a.user_id), ms(a.created_at)])
      );
      hours = ex
        .map(
          r =>
            (ms(r.at) - (created.get(String(r.user_id)) ?? ms(r.at))) / 3600000
        )
        .filter(h => h >= 0);
      const orders = await this.q(
        `SELECT user_id, status, created_at FROM mcp_order WHERE sku <> 'pay_test' AND user_id IN (${ph})`,
        ids
      );
      const firstEx = new Map(ex.map(r => [String(r.user_id), ms(r.at)]));
      const o = new Set<string>();
      const p = new Set<string>();
      for (const r of orders) {
        const u = String(r.user_id);
        if (ms(r.created_at) < (firstEx.get(u) || 0)) continue;
        o.add(u);
        if (r.status === 'paid') p.add(u);
      }
      orderedAfter = o.size;
      paidAfter = p.size;
    }
    const balances = await this.q(
      "SELECT CASE WHEN points <= 0 THEN '0' WHEN points <= 20 THEN '1-20' WHEN points <= 100 THEN '21-100' " +
        "WHEN points <= 400 THEN '101-400' ELSE '400+' END bucket, COUNT(*) n FROM mcp_account GROUP BY bucket"
    );
    const byTool: Record<string, number> = {};
    ex.forEach(r => {
      const t = r.tool || '?';
      byTool[t] = (byTool[t] || 0) + 1;
    });
    return {
      exhaustedUsers: ex.length,
      exhaustedEvents: num(evt?.exhausted),
      quotaEvents: num(evt?.quota),
      quotaUsers: num(evt?.quotaUsers),
      medianHoursToExhaust: hours.length
        ? Math.round(median(hours)! * 10) / 10
        : null,
      orderedAfterExhaust: orderedAfter,
      paidAfterExhaust: paidAfter,
      lastToolBeforeExhaust: Object.entries(byTool)
        .map(([tool, n]) => ({ tool, n }))
        .sort((a, b) => b.n - a.n),
      balances: (balances || []).map((r: any) => ({
        bucket: r.bucket,
        n: num(r.n),
      })),
    };
  }

  /** 工具：调用量、失败率、耗时分位、实扣点数（只算自助 Key）。 */
  async toolPerf(d: number, product: string | null) {
    const rows: any[] = await this.q(
      'SELECT l.product, l.tool, l.ok, l.latency_ms, l.cost, k.user_id FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id ' +
        `WHERE k.user_id IS NOT NULL AND l.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${
          product ? ' AND l.product = ?' : ''
        } ORDER BY l.id DESC LIMIT 50000`,
      product ? [d, product] : [d]
    );
    const g = new Map<
      string,
      {
        product: string;
        tool: string;
        lat: number[];
        calls: number;
        failed: number;
        points: number;
        users: Set<string>;
      }
    >();
    for (const r of rows) {
      const k = `${r.product}/${r.tool}`;
      if (!g.has(k))
        g.set(k, {
          product: r.product,
          tool: r.tool,
          lat: [],
          calls: 0,
          failed: 0,
          points: 0,
          users: new Set(),
        });
      const x = g.get(k)!;
      x.calls++;
      if (Number(r.ok) !== 1) x.failed++;
      x.lat.push(num(r.latency_ms));
      x.points += num(r.cost);
      x.users.add(String(r.user_id));
    }
    return [...g.values()]
      .map(x => {
        const s = x.lat.sort((a, b) => a - b);
        return {
          product: x.product,
          tool: x.tool,
          calls: x.calls,
          users: x.users.size,
          failed: x.failed,
          errorRate: x.calls ? Math.round((x.failed / x.calls) * 1000) / 10 : 0,
          p50: pct(s, 50),
          p95: pct(s, 95),
          points: x.points,
        };
      })
      .sort((a, b) => b.calls - a.calls);
  }

  /** 用户用什么客户端连（MCP 握手里的 clientInfo，和 Skill 插件带的 X-Journey-Client）。 */
  async clients(d: number, product: string | null) {
    const pf = product ? ' AND product = ?' : '';
    const pp = product ? [product] : [];
    const init = await this.q(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.clientName')) client, JSON_UNQUOTE(JSON_EXTRACT(props, '$.via')) via, " +
        'COUNT(*) sessions, COUNT(DISTINCT user_id) users FROM mcp_event ' +
        `WHERE event = 'mcp_initialize' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${pf} ` +
        'GROUP BY client, via ORDER BY sessions DESC LIMIT 30',
      [d, ...pp]
    );
    return (init || []).map((r: any) => ({
      client: r.client || '未知',
      via: r.via || null,
      sessions: num(r.sessions),
      users: num(r.users),
    }));
  }

  /** 流量来源：page_view 的 utm_source，没有就取 referrer 域名。 */
  async sources(d: number, product: string | null) {
    const rows = await this.q(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.utm_source')) utm, JSON_UNQUOTE(JSON_EXTRACT(props, '$.referrer')) ref, anon_id " +
        `FROM mcp_event WHERE event = 'page_view' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${
          product ? ' AND product = ?' : ''
        } LIMIT 50000`,
      product ? [d, product] : [d]
    );
    const g = new Map<string, Set<string>>();
    for (const r of rows || []) {
      let src = r.utm && r.utm !== 'null' ? `utm:${r.utm}` : '';
      if (!src) {
        try {
          src =
            r.ref && r.ref !== 'null' ? new URL(r.ref).hostname : '直接访问';
        } catch {
          src = '直接访问';
        }
      }
      if (!g.has(src)) g.set(src, new Set());
      g.get(src)!.add(String(r.anon_id));
    }
    return [...g.entries()]
      .map(([source, s]) => ({ source, visitors: s.size }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 20);
  }

  /** 页面交互：每种事件 × label/client 的次数与人数。 */
  async interactions(d: number, product: string | null) {
    const rows = await this.q(
      "SELECT page, event, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(props, '$.label')), JSON_UNQUOTE(JSON_EXTRACT(props, '$.client')), " +
        "JSON_UNQUOTE(JSON_EXTRACT(props, '$.section'))) label, COUNT(*) n, COUNT(DISTINCT anon_id) visitors FROM mcp_event " +
        `WHERE source = 'web' AND event <> 'page_view' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${
          product ? ' AND product = ?' : ''
        } GROUP BY page, event, label ORDER BY n DESC LIMIT 60`,
      product ? [d, product] : [d]
    );
    return (rows || []).map((r: any) => ({
      page: r.page,
      event: r.event,
      label: r.label && r.label !== 'null' ? r.label : null,
      n: num(r.n),
      visitors: num(r.visitors),
    }));
  }

  /** 付款：按渠道看下单 → 拿到付款链接 → 自报 → 到账。 */
  async payments(d: number) {
    const rows = await this.q(
      "SELECT event, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(props, '$.channel')), '-') channel, COUNT(*) n, " +
        "COUNT(DISTINCT user_id) users, SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(props, '$.amountCents')) AS SIGNED), 0)) cents FROM mcp_event " +
        "WHERE event IN ('order_created','pay_link_issued','order_reported','order_paid','order_rejected') " +
        "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(props, '$.sku')), '') <> 'pay_test' " +
        'AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY event, channel',
      [d]
    );
    return (rows || []).map((r: any) => ({
      event: r.event,
      channel: r.channel,
      n: num(r.n),
      users: num(r.users),
      cents: num(r.cents),
    }));
  }

  /** 出错：鉴权失败（装好了但 Key 没配对）与工具报错文案 Top。 */
  async errors(d: number, product: string | null) {
    const pf = product ? ' AND product = ?' : '';
    const pp = product ? [product] : [];
    const auth = await this.q(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.reason')) reason, COUNT(*) n FROM mcp_event " +
        `WHERE event = 'auth_failed' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${pf} GROUP BY reason`,
      [d, ...pp]
    );
    const tool = await this.q(
      'SELECT l.tool, LEFT(l.error, 80) error, COUNT(*) n FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id ' +
        `WHERE k.user_id IS NOT NULL AND l.ok = 0 AND l.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${
          product ? ' AND l.product = ?' : ''
        } GROUP BY l.tool, LEFT(l.error, 80) ORDER BY n DESC LIMIT 15`,
      [d, ...pp]
    );
    return {
      auth: (auth || []).map((r: any) => ({
        reason: r.reason || '?',
        n: num(r.n),
      })),
      tool: (tool || []).map((r: any) => ({
        tool: r.tool,
        error: r.error,
        n: num(r.n),
      })),
    };
  }

  /** 每日：访客、开通、调用人数、耗尽、下单、到账（看趋势用）。 */
  async dailyEvents(d: number, product: string | null) {
    const pp = product ? [product] : [];
    const rows = await this.q(
      "SELECT DATE(created_at) day, COUNT(DISTINCT CASE WHEN event = 'page_view' THEN anon_id END) visitors, " +
        "COUNT(DISTINCT CASE WHEN event = 'mcp_initialize' THEN user_id END) connectedUsers, " +
        "SUM(event = 'credit_exhausted') exhausted, SUM(event = 'order_created') orders, SUM(event = 'order_paid') paid " +
        `FROM mcp_event WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${
          product ? ' AND (product IS NULL OR product = ?)' : ''
        } GROUP BY DATE(created_at) ORDER BY day`,
      [d, ...pp]
    );
    return (rows || []).map((r: any) => ({
      day: String(r.day).slice(0, 10),
      visitors: num(r.visitors),
      connectedUsers: num(r.connectedUsers),
      exhausted: num(r.exhausted),
      orders: num(r.orders),
      paid: num(r.paid),
    }));
  }
}
