/**
 * 模拟面试免费体验（owner 2026-11-17 定）：每个登录的非会员终身送 1 场短版模拟面试。
 *
 * - 只支持「按目标公司」出题（题从真实面经抽，有固定题量和收尾），按知识方向练仍是会员专享；
 * - 一场 = 同一个 seed 下的连续调用：MOCK_TRIAL_QUESTIONS 道题，每道最多追问一次，再加收尾；
 * - 第一次调用就记为「用过」，换 seed 重开、刷新页面重来都不再放行；
 * - 不扣点数、不生成复盘报告（报告仍是会员权益，结束页引导开通）。
 *
 * 状态存 Redis（键见 mockTrialKey），读写失败一律按「不放行」处理，不白送。
 */
export const MOCK_TRIAL_QUESTIONS = 3;
/** 每道题至多提问 + 追问两次面试官发言，再留一次收尾和一次网络重试的余量 */
export const MOCK_TRIAL_MAX_CALLS = MOCK_TRIAL_QUESTIONS * 2 + 2;
/** 状态保留 400 天：等同于终身一次 */
export const MOCK_TRIAL_TTL_SECONDS = 400 * 24 * 60 * 60;

export interface MockTrialState {
  seed: number;
  calls: number;
  at: number;
  finished?: boolean;
}

export const mockTrialKey = (userId: string) => `iris:mocktrial:${userId}`;

export function parseMockTrialState(raw: string | null | undefined): MockTrialState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s && typeof s.seed === 'number' && typeof s.calls === 'number') return s;
  } catch {
    /* 坏数据按用过处理，见 decideMockTrial */
  }
  return { seed: -1, calls: MOCK_TRIAL_MAX_CALLS, at: 0, finished: true };
}

export function decideMockTrial(
  state: MockTrialState | null,
  seed: number,
  now = Date.now()
): { allowed: boolean; next?: MockTrialState } {
  if (!state) return { allowed: true, next: { seed, calls: 1, at: now } };
  if (state.finished || state.seed !== seed || state.calls >= MOCK_TRIAL_MAX_CALLS) {
    return { allowed: false };
  }
  return { allowed: true, next: { ...state, calls: state.calls + 1 } };
}
