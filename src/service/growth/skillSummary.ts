import type { QueryFn } from '../../mcp/store';

/**
 * Skill / MCP 开发者服务的经营汇总（2026-11-01 起进复盘导出）。
 *
 * 10/30 起产品重心转到 /developer（MCP 接入 + 支付宝收款 + 单一会员档），开通、调用、下单、
 * 到账都记在 mcp_* 表里（见 src/mcp），老的 order 表和 event_log 看不到这条链路。
 * 这里按「窗口内发生」数各步（不是后台看板那种按开通批次往下追的 cohort），并且：
 * - 排除内部账号（GROWTH_INTERNAL_USER_IDS ∪ 调用方传入）——看板不排除，两边数字会差你自测的那部分；
 * - 付款排除 1 分钱测试单（sku = 'pay_test'），与看板一致；
 * - 时间窗用库内 NOW()，与看板同一套时钟。
 * 每项单独查、失败为 null，不伪造为零；只出计数和金额，不出任何号码。
 */
export async function skillSummary(q: QueryFn, days: number, exclude: string[]) {
  const d = Math.max(1, Math.min(180, Math.floor(days) || 7));
  const ex = (exclude || []).filter(Boolean);
  const notIn = (col: string) =>
    ex.length ? ` AND (${col} IS NULL OR ${col} NOT IN (${ex.map(() => '?').join(',')}))` : '';
  const win = (col: string) => `${col} >= DATE_SUB(NOW(), INTERVAL ? DAY)`;
  const one = async (sql: string, params: any[]): Promise<Record<string, any> | null> => {
    try {
      const rows = await q(sql, params);
      return (rows && rows[0]) || {};
    } catch {
      return null;
    }
  };
  const num = (r: Record<string, any> | null, k: string) => (r == null ? null : Number(r[k] || 0));
  const money = (r: Record<string, any> | null) =>
    r == null
      ? null
      : { orders: num(r, 'orders'), users: num(r, 'users'), yuan: Number(r.cents || 0) / 100 };

  const [page, activated, keys, connected, called, ordered, paid, monthPaid] = await Promise.all([
    one(
      "SELECT COUNT(DISTINCT CASE WHEN event = 'page_view' THEN anon_id END) visitors, " +
        "COUNT(DISTINCT CASE WHEN event IN ('install_select','copy_click') THEN anon_id END) installIntent " +
        `FROM mcp_event WHERE source = 'web' AND ${win('created_at')}${notIn('user_id')}`,
      [d, ...ex]
    ),
    one(`SELECT COUNT(*) n FROM mcp_account WHERE ${win('created_at')}${notIn('user_id')}`, [d, ...ex]),
    one(`SELECT COUNT(DISTINCT user_id) n FROM mcp_api_key WHERE ${win('created_at')}${notIn('user_id')}`, [d, ...ex]),
    one(
      `SELECT COUNT(DISTINCT user_id) n FROM mcp_event WHERE event = 'mcp_initialize' AND ${win('created_at')}${notIn('user_id')}`,
      [d, ...ex]
    ),
    one(
      'SELECT COUNT(DISTINCT k.user_id) users, COUNT(*) calls FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id ' +
        `WHERE l.ok = 1 AND ${win('l.created_at')}${notIn('k.user_id')}`,
      [d, ...ex]
    ),
    one(
      "SELECT COUNT(*) orders, COUNT(DISTINCT user_id) users, COALESCE(SUM(amount_cents),0) cents FROM mcp_order WHERE sku <> 'pay_test' " +
        `AND ${win('created_at')}${notIn('user_id')}`,
      [d, ...ex]
    ),
    one(
      "SELECT COUNT(*) orders, COUNT(DISTINCT user_id) users, COALESCE(SUM(amount_cents),0) cents FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test' " +
        `AND ${win('paid_at')}${notIn('user_id')}`,
      [d, ...ex]
    ),
    one(
      "SELECT COUNT(*) orders, COUNT(DISTINCT user_id) users, COALESCE(SUM(amount_cents),0) cents FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test' " +
        `AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')${notIn('user_id')}`,
      [...ex]
    ),
  ]);

  return {
    days: d,
    basis: 'window_events_excluding_internal',
    page: page && { visitors: num(page, 'visitors'), installIntent: num(page, 'installIntent') },
    activated: num(activated, 'n'),
    keyUsers: num(keys, 'n'),
    connectedUsers: num(connected, 'n'),
    calledUsers: num(called, 'users'),
    calls: num(called, 'calls'),
    ordered: money(ordered),
    paid: money(paid),
    monthPaid: money(monthPaid),
  };
}
