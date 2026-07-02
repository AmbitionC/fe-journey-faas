import { IMidwayContainer } from '@midwayjs/core';
import { TypeORMDataSourceManager } from '@midwayjs/typeorm';
import { UserEntity } from '../entity/user';

// 投资驾驶舱管理员：该手机号的账号自动提升为 admin（写接口 assertAdmin 依赖 role）。
const INVEST_ADMIN_PHONE = process.env.INVEST_ADMIN_PHONE || '17394940726';

/**
 * 启动时幂等提升驾驶舱管理员。
 * - 账号尚未注册时静默跳过（注册后下次冷启动生效）。
 * - 任何异常仅记日志，绝不影响应用启动。
 * - 注意：token 里缓存了登录时的 role，提权后需重新登录生效。
 */
export async function ensureInvestAdmin(container: IMidwayContainer): Promise<void> {
  try {
    const mgr = await container.getAsync(TypeORMDataSourceManager);
    const ds = mgr.getDataSource('default');
    const repo = ds.getRepository(UserEntity);
    const user = await repo.findOne({ where: { phoneNumber: INVEST_ADMIN_PHONE } });
    if (!user) return;
    if (user.role !== 'admin') {
      await repo.update({ id: user.id }, { role: 'admin' });
      console.log(`[ensureInvestAdmin] ${INVEST_ADMIN_PHONE} 已提升为 admin`);
    }
  } catch (err) {
    console.error('[ensureInvestAdmin] 失败(不影响启动):', err);
  }
}
