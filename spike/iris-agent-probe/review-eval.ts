/**
 * 作业评审 Agent 离线评测：真实 DeepSeek + 本地起的同一份运行器（runner/code-runner）。
 * 两份夹具：good（实现正确）与 buggy（解析不认代码块、重试多调一次）。
 * 判据（先写死）：good 不能判 rework 且必过项 1 不能 fail；buggy 必须判 rework 且第 1 或第 3 条判 fail；
 * 两份都必须至少真跑过一次代码。
 */
import * as fs from 'fs';
import * as path from 'path';
import { runAgentReview } from '../../src/service/review/agentReview';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCode } = require('../../runner/code-runner/server.js');

const MISSION = {
  title: '模型输出校验与自动修复',
  requirements: ['从模型输出中稳健提取 JSON', '按 schema 校验', '失败时带错误反馈重试，有上限'],
  acceptanceCriteria: [
    { id: '1', text: '能从带 ```json 代码块或前后说明文字的模型输出中正确提取 JSON 对象', mustPass: true },
    { id: '2', text: '按 schema 校验必填字段与类型，返回可读的错误列表', mustPass: false },
    { id: '3', text: '校验失败时把错误反馈给模型重试，最多调用 3 次模型，仍失败返回 null', mustPass: true },
    { id: '4', text: 'README 说明了设计与使用 AI 协作的过程', mustPass: false },
  ],
};

function walk(dir: string, base = dir): { path: string; size: number }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full, base) : [{ path: path.relative(base, full), size: fs.statSync(full).size }];
  });
}

(async () => {
  if (!process.env.LLM_API_KEY) {
    console.error('缺少 LLM_API_KEY');
    process.exit(1);
  }
  const out: string[] = ['# 作业评审 Agent 评测', ''];
  let failed = 0;
  for (const name of ['good', 'buggy']) {
    const root = path.join(__dirname, 'review-fixtures', name);
    const t0 = Date.now();
    const r = await runAgentReview({
      config: { apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL || 'deepseek-flash' },
      mission: MISSION,
      retro: { strategy: '先让 AI 写解析，再补用例', aiFailed: 'AI 一开始没处理代码块', howFixed: '补了用例让它修' },
      commits: ['init', 'feat: parse + validate', 'fix: 代码块解析', 'feat: retry with feedback'],
      files: walk(root),
      readFile: async (p) => fs.readFileSync(path.join(root, p), 'utf8'),
      runCode: (req) => runCode(req),
    });
    const cv = Object.fromEntries(r.criteriaVerdicts.map((c) => [c.id, c.verdict]));
    let ok: boolean;
    if (name === 'good') ok = r.verdict !== 'rework' && cv['1'] !== 'fail' && r.runs > 0;
    else ok = r.verdict === 'rework' && (cv['1'] === 'fail' || cv['3'] === 'fail') && r.runs > 0;
    if (!ok) failed++;
    const line = `${name}: ${ok ? 'PASS' : 'FAIL'} verdict=${r.verdict} score=${r.totalScore} criteria=${JSON.stringify(cv)} runs=${r.runs}/${r.runsOk}ok files=${r.filesRead} steps=${r.steps} tokens=${r.tokenUsed} ${Date.now() - t0}ms${r.error ? ` error=${r.error}` : ''}`;
    console.log(line);
    out.push(`## ${line}`, '', ...r.criteriaVerdicts.map((c) => `- ${c.id} ${c.verdict}：${c.note}\n  证据：${c.evidence}`), '', r.report, '');
  }
  if (process.env.EVAL_OUT) fs.writeFileSync(process.env.EVAL_OUT, out.join('\n'));
  process.exit(failed ? 1 : 0);
})();
