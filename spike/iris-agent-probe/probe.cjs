// 一次性排雷脚本：用真实 DeepSeek 验证 AI SDK 在「思考 + 工具」下的行为。只打印结论，不打印 key 与正文。
const { generateText, streamText, tool, stepCountIs } = require('ai');
const { createDeepSeek } = require('@ai-sdk/deepseek');
const { z } = require('zod');
const deepseek = createDeepSeek({ apiKey: process.env.LLM_API_KEY });
const MODEL = 'deepseek-flash';
let calls = 0;
const tools = {
  search_articles: tool({
    description: '检索站内文章，返回标题与 key。回答任何技术问题前必须先调用。',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => { calls++; return { hits: [{ key: 'debounce-throttle', title: '防抖与节流', snippet: '防抖：事件停止触发 n 毫秒后才执行一次。' }] }; },
  }),
  read_article: tool({
    description: '读取文章正文',
    inputSchema: z.object({ key: z.string() }),
    execute: async ({ key }) => { calls++; return { key, body: '防抖（debounce）：在事件被触发 n 毫秒后再执行回调，若期间再次触发则重新计时。leading 选项控制是否在开始时立即执行一次。' }; },
  }),
};
const think = { deepseek: { thinking: { type: 'enabled' } } };
const results = [];
async function t(name, fn) {
  calls = 0; const t0 = Date.now();
  try { const r = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, toolCalls: calls, ...r }); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300), status: e.statusCode, body: String(e.responseBody || '').slice(0, 300) }); }
}
const summarize = (g) => ({ steps: g.steps.length, textLen: g.text.length, reasoningLen: (g.reasoningText || '').length, usage: g.totalUsage });
(async () => {
  await t('T1 单轮 思考+工具 generateText', async () => summarize(await generateText({ model: deepseek(MODEL), system: '你是学习教练，必须先检索站内文章再回答。', prompt: '防抖的 leading 是什么意思？', tools, stopWhen: stepCountIs(5), providerOptions: think })));
  // 我们现有会话历史只存了正文，不含思考内容——验证 provider 回传空 reasoning_content 时官方是否接受
  const history = [
    { role: 'user', content: '节流是什么？' },
    { role: 'assistant', content: '节流是在固定时间窗口内最多执行一次。' },
    { role: 'user', content: '那防抖的 leading 呢？请查站内文章。' },
  ];
  await t('T2 多轮(历史无思考内容) 思考+工具', async () => summarize(await generateText({ model: deepseek(MODEL), system: '你是学习教练。', messages: history, tools, stopWhen: stepCountIs(5), providerOptions: think })));
  await t('T3 流式 思考+工具 streamText', async () => {
    const s = streamText({ model: deepseek(MODEL), system: '你是学习教练，必须先检索站内文章再回答。', prompt: '防抖和节流的区别？', tools, stopWhen: stepCountIs(5), providerOptions: think });
    const kinds = {}; let firstText = null; const t0 = Date.now();
    for await (const p of s.fullStream) { kinds[p.type] = (kinds[p.type] || 0) + 1; if (p.type === 'text-delta' && firstText == null) firstText = Date.now() - t0; }
    return { parts: kinds, firstTextMs: firstText, usage: await s.totalUsage };
  });
  await t('T4 现状对照 不思考+工具', async () => summarize(await generateText({ model: deepseek(MODEL), system: '你是学习教练，必须先检索站内文章再回答。', prompt: '防抖的 leading 是什么意思？', tools, stopWhen: stepCountIs(5), providerOptions: { deepseek: { thinking: { type: 'disabled' } } } })));
  console.log('PROBE_RESULT ' + JSON.stringify(results, null, 1));
  if (results.some(r => !r.ok)) process.exitCode = 1;
})();
