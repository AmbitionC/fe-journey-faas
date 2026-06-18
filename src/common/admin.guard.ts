import { R } from './base.error.utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assertAdmin(ctx: { userInfo?: any }): void {
  if (!ctx.userInfo || ctx.userInfo.role !== 'admin') {
    throw R.unauthorizedError('需要管理员权限');
  }
}
