/**
 * 限免期判定（单一真相源）。
 *
 * 为什么不是一个静态布尔：config 在 FC 实例启动时求值一次，热实例可存活数小时甚至更久，
 * 若把「是否限免」写成启动时算好的常量，截止时刻过后老实例仍会继续按免费放行。
 * 因此这里按**每次调用**比较当前时间与截止时间。
 */
export interface MembershipConfig {
  /** 限免截止时间（ISO，含时区）。当前时间 < 该值即为限免期 */
  freeUntil?: string;
  /** 应急开关：置 true 则无视日期强制全员免费（回滚/故障时用） */
  freeForAll?: boolean;
}

/** 当前是否处于限免期 */
export function isMembershipFree(cfg?: MembershipConfig): boolean {
  if (cfg?.freeForAll === true) return true; // 应急强制免费
  const until = cfg?.freeUntil;
  if (!until) return false;
  const ts = Date.parse(until);
  if (!Number.isFinite(ts)) return false; // 配置写错时按收费处理，避免永久免费
  return Date.now() < ts;
}
