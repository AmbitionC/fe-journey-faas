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

/**
 * 存量会员列（user.isMember + user.memberDate）当前是否仍然有效——**单一真相源**。
 *
 * 两列是分开的：`isMember` 是个布尔标记，**没有任何地方会在到期时把它改回 false**，
 * 所以只看它等于「一旦是会员就永远是会员」。有效期只存在于 `memberDate` 里。
 *
 * 2026-09-13 抓到的现象：8/25~8/26 那批号的 14 天试用在 9/8~9/9 到期后，
 * `activeMembers` 归零，而 `members` 仍是 84——库里 84 行的 `isMember` 还是 true。
 * 此前 ai.ts 自己带了日期判断（对），user.getUserById 只看 `isMember`（错），
 * 于是同一个用户：前端拿到 isMember=true 渲染会员 UI 和会员额度，
 * 真去调 AI 时后端按非会员限流——界面说你是会员，接口说你不是。
 * 判定逻辑只此一份，两边都调它。
 *
 * 时区：两处写入都是 `toISOString().slice(0,19)`，即 **UTC 墙钟**，所以这里也按 UTC 解析
 * （补 'Z'）。不补的话 `Date.parse('2026-09-20T12:00:00')` 按**本地时区**解释——
 * 容器没设 TZ 时恰好等价，一旦设成 Asia/Shanghai 就凭空多给 8 小时会员。
 * metrics 的 activeMembers 是拿 UTC 字符串逐字符比的，补 'Z' 后两者口径一致。
 *
 * @param memberDate 形如 'YYYY-MM-DD HH:mm:ss'（UTC）；空串/非法值一律视为无效
 */
export function hasValidMemberColumn(
  isMember?: boolean | null,
  memberDate?: string | null
): boolean {
  if (!isMember || !memberDate) return false;
  const raw = String(memberDate).trim();
  // 已带时区信息的原样解析；否则按 UTC
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
  const ts = Date.parse(hasZone ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ts)) return false; // 解析不了按过期处理，不白送
  return ts > Date.now();
}
