/**
 * 注册来源站点（2026-10-23 owner「看看我的投资网站里有多少用户」）。
 *
 * invest-journey 与 agent-journey 共用同一张 user 表，表里没有「从哪个站注册」字段。
 * 注册请求是浏览器跨域发来的，Origin 头就是前端站点——据此判站点，前端零改动。
 * Origin 可被非浏览器客户端伪造，这里只用于统计，不用于任何权限判断。
 */
export type SignupSite = 'invest' | 'agent' | 'preview' | 'local' | 'other';

export function siteFromOrigin(origin?: string | null): SignupSite {
  if (!origin) return 'other';
  let host = '';
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host === 'invest-journey.cn' || host.endsWith('.invest-journey.cn')) return 'invest';
  if (host === 'agent-journey.cn' || host.endsWith('.agent-journey.cn')) return 'agent';
  if (host.endsWith('.vercel.app')) return 'preview';
  if (host === 'localhost' || host === '127.0.0.1') return 'local';
  return 'other';
}

/** 北京日期 YYYYMMDD（投资站按日访问记录的分区键）。 */
export function beijingDay(now: number = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}
