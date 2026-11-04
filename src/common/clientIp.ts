/**
 * 可信客户端 IP（2026-11-04 运营分析第 1 期：11-03 有人伪造 X-Forwarded-For 刷游客 Iris，
 * 19 个假 IP 一小时烧掉约 166 万 token；短信限频、注册限频、阅读额度同样按 XFF 第一个值）。
 *
 * X-Forwarded-For 的**第一个值是客户端自己写的**，谁都能填；只有最右边那一段是我们前面的代理
 * （函数计算的接入层）追加的、客户端改不了。所以：
 *   - 从右往左数 `TRUSTED_PROXY_HOPS`（默认 1）段，取那一段——这才是接入层看到的对端地址；
 *   - 没有 XFF（本地直连）时退回 socket 对端地址；
 *   - 取到的不是合法 IP（被塞了垃圾）时退回 socket 地址，再不行用 'anonymous'。
 *
 * 部署后用 GET /api/ai/whoami 自查：带上伪造的 XFF 请求，返回的 ip 不随伪造值变化才算对。
 *
 * 全仓**只许**用这一个函数取客户端 IP；别再写 `x-forwarded-for.split(',')[0]`。
 * 回归：test/clientIp.test.ts（含源码扫描，出现第一个值的写法就失败）。
 */

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+(%\w+)?$/i;

/** 规范化：去端口、去 IPv4-mapped 前缀、去方括号；不像 IP 返回 ''。 */
export function normalizeIp(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.startsWith('['))
    s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
  // 1.2.3.4:5678 → 1.2.3.4（IPv6 的冒号不能这样剥，只对点分形式处理）
  const m = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(s);
  if (m) s = m[1];
  if (s.toLowerCase().startsWith('::ffff:') && IPV4.test(s.slice(7)))
    s = s.slice(7);
  if (IPV4.test(s)) return s;
  if (s.includes(':') && IPV6.test(s) && s.length <= 45) return s.toLowerCase();
  return '';
}

function trustedHops(
  env: Record<string, string | undefined> = process.env
): number {
  const n = Number(env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

/**
 * @param xff     X-Forwarded-For 原值（可能是数组：Node 对重复头会合并成逗号串，这里两种都接）
 * @param remote  socket 对端地址（ctx.ip / req.socket.remoteAddress）
 */
export function trustedClientIp(
  xff: unknown,
  remote?: unknown,
  env?: Record<string, string | undefined>
): string {
  const raw = Array.isArray(xff) ? xff.join(',') : String(xff ?? '');
  const parts = raw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length) {
    const hops = trustedHops(env);
    const pick = parts[Math.max(0, parts.length - hops)];
    const ip = normalizeIp(pick);
    if (ip) return ip;
  }
  return normalizeIp(remote) || 'anonymous';
}

/** 从 Node 原生 req（server.js 直写路由）取。 */
export function clientIpFromReq(req: {
  headers?: Record<string, any>;
  socket?: { remoteAddress?: string };
}): string {
  return trustedClientIp(
    req?.headers?.['x-forwarded-for'],
    req?.socket?.remoteAddress
  );
}

/** 从 Midway / Koa 风格 ctx 取。 */
export function clientIpFromCtx(ctx: any): string {
  const h = ctx?.headers || ctx?.header || {};
  let xff = h['x-forwarded-for'];
  if (xff === undefined && typeof ctx?.get === 'function')
    xff = ctx.get('x-forwarded-for');
  return trustedClientIp(xff, ctx?.ip);
}

/** 自查用：把 XFF 链原样、取到的 IP 一起交给调用方看（只是调用方自己发来的东西，不泄露别人的）。 */
export function describeClientIp(xff: unknown, remote?: unknown) {
  const raw = Array.isArray(xff) ? xff.join(',') : String(xff ?? '');
  return {
    ip: trustedClientIp(xff, remote),
    chain: raw
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .slice(-6),
    remote: normalizeIp(remote) || null,
    hops: trustedHops(),
  };
}
