/**
 * 离线评测入口（PRD-02 F2-3）：node/ts-node 直接跑，结果输出 JSON。
 *   LLM_API_KEY=xxx npm run eval
 * 结果可接入 PRD-04 可观测看板（此处先落地为 JSON 报告）。
 */
import fetch from 'node-fetch';
import { runEval, CallLLM } from './runner';

const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';
const BASE = process.env.LLM_BASE || 'https://api.deepseek.com/chat/completions';

const callDeepSeek: CallLLM = async (system, user) => {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 1024,
    }),
  });
  const data = (await res.json()) as any;
  return data?.choices?.[0]?.message?.content || '';
};

async function main() {
  if (!API_KEY) {
    console.error('缺少 LLM_API_KEY，无法跑真实评测。');
    process.exit(1);
  }
  const report = await runEval(callDeepSeek);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n判分正确率 ${report.gradeAccuracy.rate * 100}%`);
}

main().catch((e) => {
  console.error('eval failed', e);
  process.exit(1);
});
