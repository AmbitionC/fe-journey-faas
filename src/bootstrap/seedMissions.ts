import { IMidwayContainer } from '@midwayjs/core';
import { MissionService } from '../service/mission';
import { MISSION_SEED } from '../data/missionSeed';

/**
 * 启动时幂等导入首批题卡（与 seedSwordOffer 同一思路：生产 DB 只能由 FC 函数访问）。
 * - 幂等：按 slug 判断，已存在的一律不动（管理后台改过的内容不会被种子覆盖）。
 * - 容错：任何异常只记日志，绝不影响启动。
 */
export async function seedMissions(container: IMidwayContainer): Promise<void> {
  try {
    const svc = await container.getAsync(MissionService);
    const n = await svc.seedMissions(MISSION_SEED);
    if (n > 0) console.log(`[seedMissions] 已导入题卡 ${n} 张`);
  } catch (err) {
    console.error('[seedMissions] 导入失败(不影响启动):', err);
  }
}
