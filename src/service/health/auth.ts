/**
 * 健康模块令牌判定（纯函数，便于单测钉死权限边界）。
 *
 * - 主令牌 HEALTH_API_TOKEN：前端 + iOS 快捷指令，全部 /health/* 与 /pos/*。
 * - 记餐专用令牌 HEALTH_AGENT_TOKEN（可选）：给 AI 助手「看图估算后落库」用，
 *   只能读当日饮食/预算、增删改餐次；读不到体成分、资产、收入、随手记等任何其他数据。
 *   泄露的最坏后果＝有人往饮食记录里乱写，可在前端删除。
 */
export type HealthTokenScope = 'full' | 'meal';

export function resolveHealthToken(
  headers: Record<string, any>,
  cfg: { apiToken?: string; agentToken?: string }
): HealthTokenScope | null {
  const got = String(
    headers['x-health-token'] || String(headers.authorization || '').replace('Bearer ', '') || ''
  );
  if (!got) return null;
  if (cfg.apiToken && got === cfg.apiToken) return 'full';
  // 记餐令牌必须与主令牌不同，且足够长，避免误配成弱口令
  if (cfg.agentToken && cfg.agentToken.length >= 16 && cfg.agentToken !== cfg.apiToken && got === cfg.agentToken)
    return 'meal';
  return null;
}
