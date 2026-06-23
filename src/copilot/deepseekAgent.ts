import { BuiltInAgent } from '@copilotkit/runtime/v2';
// @ai-sdk/openai 经 @copilotkit/runtime(锁定 1.60.2) 传递引入，已在 package-lock 中；
// 不单独声明，避免 package.json 与 lock 不同步导致部署 `npm ci` 失败。
import { createOpenAI } from '@ai-sdk/openai';

/**
 * CopilotKit v2 BuiltInAgent backed by DeepSeek (OpenAI-compatible Chat Completions).
 *
 * 关键点（踩过的坑）：
 *  - v2 runtime 的默认 agent 走 Vercel AI SDK，旧的 OpenAIAdapter(serviceAdapter) 会被绕过、无效。
 *  - @ai-sdk/openai 的 `provider(model)` 默认走 Responses API（/responses），DeepSeek 没有该端点 → 404。
 *    必须用 `.chat(model)` 强制 Chat Completions（POST {baseURL}/chat/completions）。
 *  - baseURL 用 https://api.deepseek.com（不带 /v1），与现有 proxy.ts 生产路径一致。
 *
 * Env：LLM_API_KEY（必填，运行期）、LLM_MODEL（默认 deepseek-chat）。
 */
export function makeDeepseekAgent(): BuiltInAgent {
  const deepseek = createOpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: 'https://api.deepseek.com',
  });
  return new BuiltInAgent({
    model: deepseek.chat(process.env.LLM_MODEL || 'deepseek-chat'),
  });
}
