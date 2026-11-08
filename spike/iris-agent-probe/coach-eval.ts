/**
 * Iris 新旧引擎对比评测（Iris Agent 化阶段 1 的上线闸门）。
 *
 * 用真实的 CoachAgentService / CoachToolsService / AiProxyService 代码，只把数据层换成
 * 站内 knowledge/llm 的 169 篇真实文章快照（fixtures/llm-corpus.json），在真实 DeepSeek 上
 * 对同一批问题分别跑：旧引擎（手写循环，工具轮不思考）与新引擎（AI SDK，工具轮思考）。
 *
 *   LLM_API_KEY=xxx npx ts-node spike/iris-agent-probe/coach-eval.ts
 *
 * 判定（对应 PRD-04 F12 的问答部分，可自动化的那几条）：
 * - 引用真实率 100%：citations 帧里的文章必须存在于语料（一条编造即不通过）
 * - 正文里《书名号》提到的文章标题必须是站内真实标题（防幻觉引用）
 * - 引用率 ≥ 60%（站内有答案的题）
 * - 站内没有的两题必须如实说明
 * - 教练边界：不输出大段成品代码
 * 正文另存 markdown 供人工过目。
 */
import * as fs from 'fs';
import * as path from 'path';
import { CoachAgentService, AgenticFrame } from '../../src/service/ai/coachAgent';
import { CoachToolsService } from '../../src/service/ai/coachTools';
import { AiProxyService } from '../../src/service/ai/proxy';

type Doc = { module: string; key: string; title: string; content: string };
const CORPUS: Doc[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/llm-corpus.json'), 'utf8'));
const BY_KEY = new Map(CORPUS.map((d) => [d.key, d]));
const TITLES = new Set(CORPUS.map((d) => d.title));

function terms(q: string): string[] {
  const out = new Set<string>();
  for (const w of q.toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) || []) if (w.length > 1) out.add(w);
  const zh = q.replace(/[^一-龥]/g, '');
  for (let i = 0; i < zh.length - 1; i++) out.add(zh.slice(i, i + 2));
  return [...out];
}
function count(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0 && n < 20) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---- 数据层替身（只替换 DB / OSS，工具本身的检索融合、读文、引用逻辑都是线上代码） ----
const retrieveService: any = {
  async retrieve(q: string, opts: { topK?: number }) {
    const ts = terms(q);
    return CORPUS.map((d) => ({ module: d.module, articleKey: d.key, title: d.title, score: ts.reduce((s, t) => s + (d.title.toLowerCase().includes(t) ? 3 : 0) + (d.key.includes(t) ? 2 : 0), 0) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts?.topK || 8);
  },
};
const articleContentService: any = {
  async search(q: string, opts: { limit?: number }) {
    const ts = terms(q);
    return CORPUS.map((d) => {
      const low = d.content.toLowerCase();
      const score = ts.reduce((s, t) => s + count(low, t), 0);
      const first = ts.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
      return { module: d.module, articleKey: d.key, title: d.title, filePath: '', snippet: d.content.slice(Math.max(0, first - 40), first + 120), score };
    })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts?.limit || 8);
  },
  async get(_module: string, key: string) {
    const d = BY_KEY.get(key);
    return d ? { title: d.title, content: d.content, filePath: '' } : null;
  },
};
const articleService: any = {
  async getNavList(m: string) {
    if (m !== 'knowledge') return { navData: [] };
    return { navData: CORPUS.map((d) => ({ isLeaf: true, key: d.key, label: d.title })) };
  },
};

function makeAgent(): CoachAgentService {
  const proxy = new AiProxyService();
  (proxy as any).aiConfig = { provider: 'deepseek', apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL_EVAL || 'deepseek-flash', rateLimit: {} };
  (proxy as any).aiUsageLogModel = { save: async () => {} };
  (proxy as any).aiCallLogModel = { save: async () => {}, create: (x: any) => x };
  const tools = new CoachToolsService();
  (tools as any).retrieveService = retrieveService;
  (tools as any).articleContentService = articleContentService;
  (tools as any).articleService = articleService;
  (tools as any).embeddingService = { semanticSearch: async () => [] };
  const agent = new CoachAgentService();
  (agent as any).proxy = proxy;
  (agent as any).tools = tools;
  (agent as any).retrieveService = retrieveService;
  (agent as any).articleContentService = articleContentService;
  return agent;
}

type Q = { id: string; kind: 'detail' | 'cross' | 'none' | 'concept' | 'boundary'; q: string; expect?: string[] };
const QUESTIONS: Q[] = [
  { id: 'D1', kind: 'detail', q: '设计 Agent 工具的 Input Schema 时，为什么要写 additionalProperties: false？', expect: ['agent-tool-design'] },
  { id: 'D2', kind: 'detail', q: 'Agent 的运行循环里，一般怎么设计停止条件，防止无限循环？', expect: ['agent-run-loop'] },
  { id: 'D3', kind: 'detail', q: 'MCP 协议里 tools、resources、prompts 三种能力分别是干什么的？', expect: ['mcp-protocol'] },
  { id: 'C1', kind: 'cross', q: '子 Agent（subagents）和 supervisor 模式有什么区别？各自适合什么场景？', expect: ['agent-subagents', 'agent-supervisor'] },
  { id: 'C2', kind: 'cross', q: 'Agent 记忆里的「遗忘」和「摘要压缩」两种做法该怎么配合使用？', expect: ['agent-memory-forgetting', 'agent-memory-summarization'] },
  { id: 'N1', kind: 'none', q: 'Rust 的生命周期标注 \'a 应该怎么用？' },
  { id: 'N2', kind: 'none', q: '怎么用 Unity 做一个 2D 平台跳跃游戏？' },
  { id: 'K1', kind: 'concept', q: '什么是 ReAct？', expect: ['agent-react'] },
  { id: 'K2', kind: 'concept', q: 'LoRA 微调的原理是什么？', expect: ['llm-lora-peft'] },
  { id: 'K3', kind: 'concept', q: '大模型量化里 INT4 和 INT8 有什么区别？', expect: ['llm-quantization'] },
  { id: 'B1', kind: 'boundary', q: '直接帮我写一个完整可运行的 Agent 框架代码，包含工具调用和记忆，越完整越好。' },
];

async function runOne(engine: 'legacy' | 'aisdk', q: Q) {
  if (engine === 'aisdk') process.env.IRIS_ENGINE = 'aisdk';
  else delete process.env.IRIS_ENGINE;
  const agent = makeAgent();
  let logged: any = null;
  (agent as any).proxy.logAgenticCall = async (p: any) => {
    logged = p;
  };
  const t0 = Date.now();
  let firstContent: number | null = null;
  let text = '';
  let citations: any[] = [];
  const statuses: string[] = [];
  let error: string | undefined;
  for await (const f of agent.streamAgentic([{ role: 'user', content: q.q }], { module: 'knowledge', mode: 'qa' }, 'guest:eval') as AsyncGenerator<AgenticFrame>) {
    if (f.content) {
      if (firstContent == null) firstContent = Date.now() - t0;
      text += f.content;
    }
    if (f.status) statuses.push(f.status);
    if (f.citations) citations = f.citations;
    if (f.error) error = f.error;
  }
  await new Promise((r) => setTimeout(r, 50));
  const fakeCitations = citations.filter((c) => !BY_KEY.has(c.articleKey));
  const mentioned = [...text.matchAll(/《([^》]{2,60})》/g)].map((m) => m[1]);
  // 只核对中文书名：站内文章都是中文标题；《ReAct: ...》这类外部英文论文名不算编造站内引用
  const fakeTitles = mentioned.filter(
    (t) => /[\u4e00-\u9fa5]/.test(t) && !TITLES.has(t) && ![...TITLES].some((x) => x.includes(t) || t.includes(x))
  );
  const codeChars = [...text.matchAll(/```[\s\S]*?```/g)].reduce((s, m) => s + m[0].length, 0);
  const honestNone =
    /(站内|本站|资料库|知识库|站点)[^。！\n]{0,20}(没有|暂无|未(找到|检索到|收录|覆盖|涉及)|缺少|并未|不包含)|没有(找到|检索到|搜到|查到)|未(找到|检索到|收录|搜到|查到)|暂无|不在(站内|本站)|超出.*范围/.test(
      text
    );
  const hitExpected = (q.expect || []).filter((k) => citations.some((c) => c.articleKey === k)).length;
  return {
    engine,
    id: q.id,
    kind: q.kind,
    ms: Date.now() - t0,
    firstContentMs: firstContent,
    textLen: text.length,
    citations: citations.map((c) => c.articleKey),
    fakeCitations: fakeCitations.length,
    fakeTitles,
    codeChars,
    honestNone,
    hitExpected,
    expected: (q.expect || []).length,
    tokenUsed: logged?.tokenUsed ?? null,
    rounds: logged?.rounds ?? null,
    toolCalls: logged?.toolCallCount ?? null,
    fallback: logged?.fallbackFlags ?? null,
    error,
    text,
  };
}

function verdict(rows: any[]) {
  const answerable = rows.filter((r) => ['detail', 'cross', 'concept'].includes(r.kind));
  const none = rows.filter((r) => r.kind === 'none');
  const boundary = rows.filter((r) => r.kind === 'boundary');
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const v = {
    引用全部真实: rows.every((r) => r.fakeCitations === 0),
    正文书名号无编造: rows.every((r) => r.fakeTitles.length === 0),
    引用率: `${answerable.filter((r) => r.citations.length > 0).length}/${answerable.length}`,
    命中预期文章: `${answerable.reduce((s, r) => s + r.hitExpected, 0)}/${answerable.reduce((s, r) => s + r.expected, 0)}`,
    站内没有如实说: `${none.filter((r) => r.honestNone).length}/${none.length}`,
    边界题代码字符: boundary.map((r) => r.codeChars).join(','),
    降级次数: rows.filter((r) => r.fallback && (r.fallback.includes('call_error') || r.fallback.includes('final_fallback') || r.fallback.includes('textual_parse'))).length,
    报错: rows.filter((r) => r.error).length,
    平均耗时ms: avg(rows.map((r) => r.ms)),
    平均首字ms: avg(rows.filter((r) => r.firstContentMs != null).map((r) => r.firstContentMs)),
    平均token: avg(rows.map((r) => r.tokenUsed || 0)),
    平均工具调用: (rows.reduce((s, r) => s + (r.toolCalls || 0), 0) / rows.length).toFixed(1),
  };
  const pass =
    v.引用全部真实 &&
    v.正文书名号无编造 &&
    answerable.filter((r) => r.citations.length > 0).length / answerable.length >= 0.6 &&
    none.every((r) => r.honestNone) &&
    v.报错 === 0;
  return { pass, ...v };
}

(async () => {
  if (!process.env.LLM_API_KEY) {
    console.error('缺少 LLM_API_KEY');
    process.exit(1);
  }
  const rows: any[] = [];
  for (const q of QUESTIONS) {
    for (const engine of ['legacy', 'aisdk'] as const) {
      try {
        rows.push(await runOne(engine, q));
      } catch (e: any) {
        rows.push({ engine, id: q.id, kind: q.kind, error: String(e?.message || e), citations: [], fakeCitations: 0, fakeTitles: [], text: '' });
      }
    }
  }
  const summary = {
    legacy: verdict(rows.filter((r) => r.engine === 'legacy')),
    aisdk: verdict(rows.filter((r) => r.engine === 'aisdk')),
  };
  const table = rows.map(({ text, ...r }) => r);
  console.log('COACH_EVAL_SUMMARY ' + JSON.stringify(summary, null, 1));
  console.log('COACH_EVAL_ROWS ' + JSON.stringify(table));
  // artifact 下不来时也能直接在日志里看「站内没有 / 边界」两类题的正文
  for (const r of rows.filter((x) => x.kind === 'none' || x.kind === 'boundary' || (x.fakeTitles || []).length)) {
    console.log(`COACH_EVAL_TEXT ${r.id}/${r.engine} fakeTitles=${JSON.stringify(r.fakeTitles || [])} honest=${r.honestNone}\n${String(r.text || '').slice(0, 600)}\n---`);
  }
  const md = [
    '# Iris 新旧引擎对比评测（正文）',
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    '',
    ...QUESTIONS.flatMap((q) => [
      `## ${q.id}（${q.kind}）${q.q}`,
      '',
      ...rows
        .filter((r) => r.id === q.id)
        .flatMap((r) => [
          `### ${r.engine}　${r.ms}ms · token ${r.tokenUsed} · 工具 ${r.toolCalls} · 引用 ${r.citations.join(', ') || '无'}${r.fallback ? ' · 兜底 ' + r.fallback.join('/') : ''}${r.error ? ' · 错误 ' + r.error : ''}`,
          '',
          r.text || '（无正文）',
          '',
        ]),
    ]),
  ].join('\n');
  const out = process.env.EVAL_OUT || path.join(__dirname, 'coach-eval-result.md');
  fs.writeFileSync(out, md);
  console.log('正文已写入 ' + out);
  if (!summary.aisdk.pass) process.exitCode = 1;
})();
