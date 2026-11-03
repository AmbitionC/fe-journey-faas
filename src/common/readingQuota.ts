/**
 * 非会员阅读额度（owner 2026-11-03 定）：会员不限；非会员面经、知识点**每个模块各**有固定篇数，终身不重置。
 *   - 游客 3 篇：前端本机计数（front-end-journey `utils/readingQuota.ts`），到额提示登录；
 *   - 登录非会员 5 篇：这里按 article_view_log（fingerprint=userId）里看过的不同篇数判定，到额提示开会员。
 * 看过的文章随时可以重看，不再占额度。改篇数只改这里与前端 GUEST_QUOTA。
 */
export const READING_QUOTA = Object.freeze({
  guest: 3,
  login: 5,
});

/** 受额度约束的模块；其余模块（项目文章等）不拦。 */
export const QUOTA_MODULES = ['interview', 'knowledge'] as const;

export interface QuotaDecision {
  allowed: boolean;
  /** 计上本篇之后已用的篇数（被拦时为已用篇数） */
  used: number;
  quota: number;
  /** 本篇是否新占用一个额度 */
  consumes: boolean;
}

export function decideReading(
  readKeys: Set<string>,
  articleKey: string,
  quota: number
): QuotaDecision {
  if (readKeys.has(articleKey)) {
    return { allowed: true, used: readKeys.size, quota, consumes: false };
  }
  if (readKeys.size < quota) {
    return { allowed: true, used: readKeys.size + 1, quota, consumes: true };
  }
  return { allowed: false, used: readKeys.size, quota, consumes: false };
}
