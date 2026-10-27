/**
 * 6 位纯数字证券代码补交易所后缀（2026-10-27 外部可用性体检）。
 *
 * 个人记账允许手输代码，用户常输「510300」不带后缀；而行情表 stock_daily 的代码带后缀
 * （510300.SH），于是这类流水永远显示「暂无行情」。规则：5/6/9 开头→.SH，0/1/2/3 开头→.SZ
 * （覆盖沪深 ETF 与股票）；已带后缀或其它形态原样（转大写）。
 */
export function normalizeSecCode(raw: unknown): string {
  const c = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!/^\d{6}$/.test(c)) return c;
  if (/^[569]/.test(c)) return `${c}.SH`;
  if (/^[0-3]/.test(c)) return `${c}.SZ`;
  return c;
}

/** 预警推送通道是否已开通（部署时由 secrets 是否配置算出，只下发布尔）。 */
export function alertChannels(env: NodeJS.ProcessEnv = process.env): {
  email: boolean;
  wechat: boolean;
} {
  return {
    email: env.ALERT_MAIL_READY === '1',
    wechat: env.ALERT_WX_READY === '1',
  };
}
