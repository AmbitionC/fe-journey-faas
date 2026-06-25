import { IMidwayContainer } from '@midwayjs/core';
import { AlgorithmService } from '../service/algorithm/index';
import { SWORD_OFFER_PROBLEMS } from '../data/swordOfferProblems';

// 哨兵题:剑指 Offer 03。存在即视为已导入，跳过(幂等)。
const SENTINEL_SLUG = 'lcof-03-find-repeat-number';

/**
 * 启动时幂等导入「剑指 Offer」题库到 algorithm_problem。
 * 设计原因:本地无 DB/Redis 凭据、生产 DB 走 FC 内网，无法从外部调鉴权的 /algorithm/import，
 * 故把题库随代码入库，部署后由 FC 函数(有 DB 权限)在 onReady 自动导入一次。
 * - 幂等:哨兵题已存在则直接返回；importProblems 本身也按 slug upsert，重复运行安全。
 * - 容错:任何异常仅记日志，绝不影响应用启动。
 */
export async function seedSwordOffer(container: IMidwayContainer): Promise<void> {
  try {
    const svc = await container.getAsync(AlgorithmService);
    if (await svc.hasProblem(SENTINEL_SLUG)) {
      return;
    }
    const res = await svc.importProblems(JSON.stringify(SWORD_OFFER_PROBLEMS));
    console.log(
      `[seedSwordOffer] 已导入剑指 Offer 题库: ${res?.imported ?? 0} 题`
    );
  } catch (err) {
    console.error('[seedSwordOffer] 导入失败(不影响启动):', err);
  }
}
