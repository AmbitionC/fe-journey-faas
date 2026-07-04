import { R } from './base.error.utils';

/**
 * 从登录态解析用户 {userId, role}。聚合 FaaS 下中间件的 ctx.userInfo 不一定透传到
 * service，故优先直接用请求头 token 反查 Redis（与 AuthMiddleware 同源、最可靠），
 * ctx.userInfo 仅作快路径兜底。
 */
export async function resolveUserInfo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisService?: any
): Promise<{ userId?: string; role?: string } | null> {
  if (ctx?.userInfo?.userId) return ctx.userInfo;
  try {
    const h = ctx?.header || ctx?.headers || {};
    const token = (h.token as string) || (h.authorization as string)?.replace('Bearer ', '');
    if (token && redisService) {
      const s = await redisService.get(`token:${token}`);
      if (s) return JSON.parse(s);
    }
  } catch {
    // 反查失败视为未登录
  }
  return null;
}

/** 管理员校验：解析登录态后要求 role=admin，否则抛未授权。 */
export async function assertAdmin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisService?: any
): Promise<void> {
  const info = await resolveUserInfo(ctx, redisService);
  if (!info || info.role !== 'admin') {
    throw R.unauthorizedError('需要管理员权限');
  }
}
