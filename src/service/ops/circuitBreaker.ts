/**
 * 异常熔断——纯逻辑（PRD-08）。
 * 滑动窗口计数：单位时间内同类自动动作超过阈值即熔断（防失控）。
 */

export interface BreakerState {
  count: number;
  windowStart: number; // ms
}

export interface BreakerResult {
  allowed: boolean;
  tripped: boolean;
  state: BreakerState;
  remaining: number;
}

/**
 * 计算一次动作后的熔断状态。
 * - 窗口过期则重置计数。
 * - count 超过 limit 即熔断（allowed=false）。
 */
export function nextBreaker(
  prev: BreakerState | null,
  now: number,
  windowMs: number,
  limit: number
): BreakerResult {
  let state: BreakerState;
  if (!prev || now - prev.windowStart >= windowMs) {
    state = { count: 1, windowStart: now };
  } else {
    state = { count: prev.count + 1, windowStart: prev.windowStart };
  }
  const tripped = state.count > limit;
  return {
    allowed: !tripped,
    tripped,
    state,
    remaining: Math.max(0, limit - state.count),
  };
}
