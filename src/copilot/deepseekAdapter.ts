import { OpenAIAdapter } from '@copilotkit/runtime';
import OpenAI from 'openai';

/**
 * Creates a CopilotKit ServiceAdapter backed by DeepSeek (OpenAI-compatible API).
 *
 * Environment variables consumed:
 *   LLM_API_KEY          — DeepSeek API key (required at runtime)
 *   LLM_MODEL            — chat model name (default: deepseek-chat)
 *   LLM_REASONER_MODEL   — deep-thinking model (default: deepseek-reasoner)
 *                          reserved for future use; not yet wired because
 *                          OpenAIAdapter does not expose a hook to capture
 *                          delta.reasoning_content from the SSE stream
 *                          (see reasoning transparency note below).
 *
 * Reasoning transparency status: NOT SUPPORTED by this adapter version.
 * OpenAIAdapter v1.60.2 only inspects delta.content and delta.tool_calls[].
 * delta.reasoning_content (DeepSeek reasoner's thinking token) is silently
 * dropped.  To expose it to the frontend, a custom ServiceAdapter would need
 * to be written that re-implements the streaming loop and encodes reasoning
 * tokens into a separate TextMessage (e.g. prefixed "【思考】") before the
 * main response.  This is non-trivial but feasible without forking the package.
 */
export function makeServiceAdapter(): OpenAIAdapter {
  const openai = new OpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: 'https://api.deepseek.com',
  });

  return new OpenAIAdapter({
    openai,
    model: process.env.LLM_MODEL || 'deepseek-chat',
    // DeepSeek does not support parallel tool calls in the same way OpenAI does;
    // disable to avoid unexpected behaviour.
    disableParallelToolCalls: true,
    // DeepSeek expects the "system" role (not "developer")
    keepSystemRole: true,
  } as any);
}
