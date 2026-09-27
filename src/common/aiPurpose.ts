/**
 * AI 调用的「用途」判定——**单一真相源，两个入口共用**。
 *
 * 为什么必须共用：`/api/ai/chat/stream` 有两个实现——
 * `src/function/ai.ts` 里的 Midway 处理器，以及 `server.js` 里绕过框架直写 SSE 的
 * `handleStream`。**线上真正服务这条路由的是后者**（server.js 顶部注释写着
 * 「唯独 POST /api/ai/chat/stream 绕过框架」）。2026-09-20 我只改了前者，
 * 测试全绿、部署全绿，线上却毫无变化——改在了不服务流量的那一份上。
 * 把判定收进这里，让两边只能引用同一份。
 */

/** 被承认的辅助用途：由界面自动发起，不是用户提问。新增时前后端同步改。 */
export const AUX_PURPOSES = new Set(['suggest']);

/** 是否为辅助调用。 */
export function isAuxPurpose(purpose?: unknown): boolean {
  return AUX_PURPOSES.has(String(purpose ?? ''));
}

/**
 * 辅助调用的计量 module（`aux:<purpose>`）；非辅助调用返回 undefined。
 * 计量分开后，/growth/export 的 aiUsage.byModule 才能回答
 * 「多少 token 是用户在问、多少是界面自动问的」。
 */
export function auxModuleFor(purpose?: unknown): string | undefined {
  return isAuxPurpose(purpose) ? `aux:${String(purpose)}` : undefined;
}

/** 辅助调用的限流桶名；非辅助调用返回 undefined（走用户自己的桶）。 */
export function auxBucketFor(purpose?: unknown): 'aux' | undefined {
  return isAuxPurpose(purpose) ? 'aux' : undefined;
}
