/**
 * 非会员阅读额度（owner 2026-11-03 定，同日改为**每天**）：会员不限；非会员面经、知识点、算法题**每个模块各自**
 * 每天能新看固定篇（道）数，北京时间零点重置；以前看过的随时能重看、不占当天额度。
 *   算法题（module=algorithm，articleKey=题目 slug）只记浏览日志、不建 article 行。
 *   - 游客每天 3 篇：前端本机计数（front-end-journey `utils/readingQuota.ts`），到额提示登录；
 *   - 登录非会员每天 5 篇：这里按 article_view_log（fingerprint=userId）判定——某篇第一次被看的日期是今天才算今天的额度，到额提示开会员。
 * 看过的文章随时可以重看，不再占额度。改篇数只改这里与前端 GUEST_QUOTA。
 */
export const READING_QUOTA = Object.freeze({
  guest: 3,
  login: 5,
});

/** 受额度约束的模块；其余模块（项目文章等）不拦。 */
export const QUOTA_MODULES = [
  'interview',
  'knowledge',
  'algorithm',
  'soe',
  'civil',
] as const;

export interface QuotaDecision {
  allowed: boolean;
  /** 计上本篇之后已用的篇数（被拦时为已用篇数） */
  used: number;
  quota: number;
  /** 本篇是否新占用一个额度 */
  consumes: boolean;
}

/** 北京时间的日期 YYYY-MM-DD（额度按北京时间零点重置；article_view_log.viewDate 也按它写） */
export function beijingDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * @param everKeys 这个模块以前看过的全部（含今天）
 * @param todayNewKeys 第一次在今天看的（占今天额度的那些）
 */
export function decideReading(
  everKeys: Set<string>,
  todayNewKeys: Set<string>,
  articleKey: string,
  quota: number
): QuotaDecision {
  const used = todayNewKeys.size;
  if (everKeys.has(articleKey)) {
    return { allowed: true, used, quota, consumes: false };
  }
  if (used < quota) {
    return { allowed: true, used: used + 1, quota, consumes: true };
  }
  return { allowed: false, used, quota, consumes: false };
}
