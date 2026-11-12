/**
 * 排行榜公共小工具（学习榜 / 刷题榜共用）。
 *
 * 隐私：榜单对所有访客可见，只回昵称 / 头像 / 名次，不回手机号。
 * 但不少人注册时直接把手机号或长串数字填成了昵称，原样上榜等于把手机号公开，
 * 所以别人的昵称里 ≥7 位的连续数字一律打码（本人看自己那行不打码）。
 */
export function publicNickName(nick: string | null | undefined): string {
  const name = (nick || '').trim();
  if (!name) return '匿名用户';
  return name.replace(/\d{7,}/g, (run) => {
    const keepHead = 3;
    const keepTail = 2;
    return run.slice(0, keepHead) + '*'.repeat(run.length - keepHead - keepTail) + run.slice(-keepTail);
  });
}

/** 北京时间本月 1 日零点（作为 Date，给 createTime 这类时间列做下界） */
export function beijingMonthStart(now: Date = new Date()): Date {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const m = bj.getUTCMonth();
  return new Date(Date.UTC(y, m, 1) - 8 * 3600 * 1000);
}
