/**
 * LLM 模型名的唯一真源（owner 2026-11-07：「DeepSeek 模型换到 4.1 Flash」）。
 *
 * DeepSeek 官方只给 `deepseek-flash` 这一个名字指向 V4.1-Flash（当前 V4.1-Flash-1017），
 * 没有带日期的显式 id。线上 FC 的 `LLM_MODEL` 环境变量是 Actions secret、仓库里看不到，
 * 历史上可能还留着 deepseek-chat / deepseek-v4-flash 之类的旧名——官方对旧名要么已停用、
 * 要么临时转发，不该靠运气。于是这里把所有已知旧名统一归到 Flash，并在启动日志里说明；
 * 真正的新模型名（将来的 V4.1 Pro 等）仍可用环境变量指定。
 */
export const DEEPSEEK_FLASH = 'deepseek-flash';

/** 已停用 / 临时转发 / 不再想用的 DeepSeek 旧模型名（小写比较）。 */
const DEEPSEEK_LEGACY = new Set([
  'deepseek-chat', // 2026-07-24 停用
  'deepseek-reasoner', // 2026-07-24 停用
  'deepseek-v3',
  'deepseek-v3.1',
  'deepseek-v3.2',
  'deepseek-v3.2-exp',
  'deepseek-v4-flash', // 2026-09-10 下线，官方临时转发到 Flash
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro', // 2026-11-07 owner 定：全部换到 4.1 Flash
]);

/**
 * 解析 DeepSeek 供应商下实际要用的模型名：
 * - 空值 → Flash；
 * - 已知旧名 → Flash（并通过 onRemap 告知，便于日志留痕）；
 * - 其他值 → 原样返回（允许将来新模型名）。
 */
export function resolveDeepseekModel(
  raw: string | undefined | null,
  onRemap?: (from: string, to: string) => void
): string {
  const value = (raw || '').trim();
  if (!value) return DEEPSEEK_FLASH;
  if (DEEPSEEK_LEGACY.has(value.toLowerCase())) {
    if (value !== DEEPSEEK_FLASH) onRemap?.(value, DEEPSEEK_FLASH);
    return DEEPSEEK_FLASH;
  }
  return value;
}

/** 按供应商解析主模型名：非 deepseek 供应商（openai / dashscope）尊重环境变量，不做归一。 */
export function resolveLlmModel(
  provider: string | undefined,
  raw: string | undefined | null,
  fallback: string = DEEPSEEK_FLASH,
  onRemap?: (from: string, to: string) => void
): string {
  const p = (provider || 'deepseek').toLowerCase();
  if (p === 'deepseek') return resolveDeepseekModel(raw, onRemap);
  return (raw || '').trim() || fallback;
}

let warned = false;
/** 启动期一次性归一（给 config.default.ts 用）：旧名命中时只打一行日志。 */
export function resolveLlmModelFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { model: string; reportModel: string } {
  const provider = env.LLM_PROVIDER || 'deepseek';
  const remaps: string[] = [];
  const note = (from: string, to: string) => remaps.push(`${from} → ${to}`);
  const model = resolveLlmModel(provider, env.LLM_MODEL, DEEPSEEK_FLASH, note);
  // 面试复盘报告模型：2026-11-07 起缺省也走 Flash（原 deepseek-v4-pro），IRIS_REPORT_MODEL 仍可覆盖
  const reportModel = resolveLlmModel(provider, env.IRIS_REPORT_MODEL, model, note);
  if (remaps.length && !warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(`[llm] 旧模型名已归一到 DeepSeek V4.1 Flash：${remaps.join('；')}`);
  }
  return { model, reportModel };
}
