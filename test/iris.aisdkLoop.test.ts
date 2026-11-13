import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { runAiSdkLoop, LoopEvent, stripPreface, splitAtToolMarkup } from '../src/service/ai/aisdkLoop';

/**
 * 模拟 DeepSeek（OpenAI 兼容流式接口），按脚本逐次返回。
 * 严格执行官方规则：请求带 tools 时，历史里每个 assistant 都必须带 reasoning_content，否则 400。
 */
type Turn =
  | { text: string; reasoning?: string }
  | { tool: { name: string; args: any }; reasoning?: string; preface?: string }
  | { status: number };

function startMock(script: Turn[]) {
  const requests: any[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      requests.push(body);
      if (body.tools) {
        for (const m of body.messages) {
          if (m.role === 'assistant' && m.reasoning_content == null) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'reasoning_content missing' } }));
          }
        }
      }
      const turn = script[Math.min(i++, script.length - 1)];
      if ('status' in turn) {
        res.writeHead(turn.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock failure' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: any, finish?: string) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'x',
              object: 'chat.completion.chunk',
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finish || null }],
              ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 60 } } : {}),
            }) +
            '\n\n'
        );
      send({ role: 'assistant', reasoning_content: turn.reasoning ?? '思考' });
      if ('tool' in turn) {
        if (turn.preface) send({ content: turn.preface });
        send({
          tool_calls: [
            { index: 0, id: `call_${i}`, type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } },
          ],
        });
        send({}, 'tool_calls');
      } else {
        // 分两段吐，验证流式拼接
        const half = Math.ceil(turn.text.length / 2);
        send({ content: turn.text.slice(0, half) });
        send({ content: turn.text.slice(half) });
        send({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise<{ url: string; requests: any[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

const TOOL_DEFS: any[] = [
  { type: 'function', function: { name: 'search_articles', description: 's', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_article', description: 'r', parameters: { type: 'object', properties: { module: { type: 'string' }, key: { type: 'string' } }, required: ['module', 'key'] } } },
  { type: 'function', function: { name: 'ask_question', description: 'q', parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } } },
];

async function collect(url: string, maxRounds = 4, executed: string[] = []) {
  const events: LoopEvent[] = [];
  for await (const ev of runAiSdkLoop({
    config: { apiKey: 'test', model: 'deepseek-flash', baseURL: url },
    systemPrompt: 'iris',
    messages: [
      { role: 'user', content: '节流是什么' },
      { role: 'assistant', content: '节流是固定窗口内最多执行一次。' },
      { role: 'user', content: '防抖呢' },
    ],
    toolDefs: TOOL_DEFS,
    executeTool: async (name, args) => {
      executed.push(`${name}:${JSON.stringify(args)}`);
      return `结果(${name})`;
    },
    maxRounds,
  })) {
    events.push(ev);
  }
  return events;
}

const text = (evs: LoopEvent[]) => evs.filter((e) => e.type === 'content').map((e: any) => e.text).join('');
const done = (evs: LoopEvent[]) => evs.find((e) => e.type === 'done') as any;

describe('Iris 工具循环（AI SDK）', () => {
  it('检索 → 读文 → 流式终答；多轮历史 + 思考 + 工具时 reasoning_content 全程回传', async () => {
    const m = await startMock([
      { tool: { name: 'search_articles', args: { query: '防抖' } } },
      { tool: { name: 'read_article', args: { module: 'knowledge', key: 'debounce' } } },
      { text: '防抖是事件停止触发 n 毫秒后才执行一次回调，期间再次触发会重新计时。' },
    ]);
    const executed: string[] = [];
    try {
      const evs = await collect(m.url, 4, executed);
      assert.deepStrictEqual(executed, ['search_articles:{"query":"防抖"}', 'read_article:{"module":"knowledge","key":"debounce"}']);
      assert.strictEqual(evs.filter((e) => e.type === 'status').length, 2);
      assert.strictEqual(text(evs), '防抖是事件停止触发 n 毫秒后才执行一次回调，期间再次触发会重新计时。');
      const d = done(evs);
      assert.strictEqual(d.answered, true);
      assert.strictEqual(d.toolCallCount, 2);
      assert.strictEqual(d.rounds, 3);
      assert.strictEqual(d.tokenUsed, 330);
      assert.deepStrictEqual(d.fallbackFlags, []);
      // 每次请求都开了思考
      assert.ok(m.requests.every((r) => r.thinking?.type === 'enabled'));
      // 第 3 次请求里，前两步工具调用的思考内容被原样回传
      const rc = m.requests[2].messages.filter((x: any) => x.role === 'assistant').map((x: any) => x.reasoning_content);
      assert.ok(rc.includes('思考'));
    } finally {
      m.close();
    }
  });

  it('ask_question：发 question 帧后立即结束，不产出终答、不执行任何工具', async () => {
    const m = await startMock([{ tool: { name: 'ask_question', args: { question: '防抖和节流哪个适合搜索框？', options: ['防抖', '节流'] } } }]);
    const executed: string[] = [];
    try {
      const evs = await collect(m.url, 3, executed);
      const q = evs.find((e) => e.type === 'question') as any;
      assert.ok(q);
      assert.deepStrictEqual(q.question.options, ['防抖', '节流']);
      assert.strictEqual(q.question.allowFreeText, true);
      assert.strictEqual(text(evs), '');
      assert.strictEqual(done(evs).answered, true);
      assert.deepStrictEqual(executed, []);
      assert.strictEqual(m.requests.length, 1);
    } finally {
      m.close();
    }
  });

  it('兜底①：同名同参重复调用 → 不再执行，下一步收掉工具强制终答', async () => {
    const m = await startMock([
      { tool: { name: 'search_articles', args: { query: '防抖' } } },
      { tool: { name: 'search_articles', args: { query: '防抖' } } },
      { text: '根据已查到的资料，防抖是延迟执行。' },
    ]);
    const executed: string[] = [];
    try {
      const evs = await collect(m.url, 4, executed);
      assert.strictEqual(executed.length, 1);
      assert.ok(done(evs).fallbackFlags.includes('dedup_stop'));
      assert.strictEqual(m.requests[2].tools, undefined, '强制终答那一步不应再带工具');
      assert.strictEqual(text(evs), '根据已查到的资料，防抖是延迟执行。');
    } finally {
      m.close();
    }
  });

  it('兜底④：轮数用尽时最后一步不带工具，模型只能作答', async () => {
    const m = await startMock([
      { tool: { name: 'search_articles', args: { query: 'a' } } },
      { tool: { name: 'search_articles', args: { query: 'b' } } },
      { text: '两轮检索后给出的回答，内容足够长可以直接展示给用户看。' },
    ]);
    try {
      const evs = await collect(m.url, 2);
      assert.strictEqual(m.requests.length, 3);
      assert.ok(m.requests[0].tools && m.requests[1].tools);
      assert.strictEqual(m.requests[2].tools, undefined);
      assert.ok(done(evs).fallbackFlags.includes('rounds_exhausted'));
      assert.strictEqual(done(evs).answered, true);
    } finally {
      m.close();
    }
  });

  it('工具调用前的过场话（「我先查一下」）不展示给用户', async () => {
    const m = await startMock([
      { tool: { name: 'search_articles', args: { query: '防抖' } }, preface: '我先查一下站内资料。' },
      { text: '防抖：停止触发后才执行。' },
    ]);
    try {
      const evs = await collect(m.url);
      assert.strictEqual(text(evs), '防抖：停止触发后才执行。');
    } finally {
      m.close();
    }
  });

  it('超过 40 字的过场话也不展示；终答开头的过场句被剥掉', async () => {
    const m = await startMock([
      { tool: { name: 'search_articles', args: { query: 'schema' } }, preface: '我先查一下站内关于 Function Calling / Input Schema 和 additionalProperties 的资料。' },
      { text: '我先查一下站内资料。**一句话：additionalProperties 默认是 true，写 false 才是封闭白名单。**' },
    ]);
    try {
      const evs = await collect(m.url);
      assert.strictEqual(text(evs), '**一句话：additionalProperties 默认是 true，写 false 才是封闭白名单。**');
    } finally {
      m.close();
    }
  });

  it('stripPreface 只剥过场句，不误伤正文', () => {
    assert.strictEqual(stripPreface('让我先检索一下。防抖是……'), '防抖是……');
    assert.strictEqual(stripPreface('我来讲讲防抖。'), '我来讲讲防抖。');
    assert.strictEqual(stripPreface('防抖是停止触发后才执行。'), '防抖是停止触发后才执行。');
  });

  it('兜底②：模型把工具调用写进正文 → 不展示，标记 textual_parse 交给降级链', async () => {
    const m = await startMock([{ text: '{"name":"search_articles","arguments":{"query":"防抖"}}' }]);
    try {
      const evs = await collect(m.url);
      assert.strictEqual(text(evs), '');
      const d = done(evs);
      assert.strictEqual(d.answered, false);
      assert.ok(d.fallbackFlags.includes('textual_parse'));
    } finally {
      m.close();
    }
  });

  const DSML =
    '<｜DSML｜function_calls>\n<｜DSML｜invoke name="search_articles">\n<｜DSML｜parameter name="query" string="true">虚拟线程</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';

  it('兜底②：模型把工具调用写成 DSML 标签 → 一个字都不展示，交给降级链', async () => {
    const m = await startMock([{ text: DSML }]);
    try {
      const evs = await collect(m.url);
      assert.strictEqual(text(evs), '');
      const d = done(evs);
      assert.strictEqual(d.answered, false);
      assert.ok(d.fallbackFlags.includes('textual_parse'));
    } finally {
      m.close();
    }
  });

  it('兜底②：先说了一句过场话再写 DSML 标签 → 同样不展示、不算答上', async () => {
    const m = await startMock([{ text: '好的，我先查一下站内有没有虚拟线程的文章。\n\n' + DSML }]);
    try {
      const evs = await collect(m.url);
      assert.ok(!text(evs).includes('DSML'), text(evs));
      assert.ok(!text(evs).includes('invoke'), text(evs));
      assert.strictEqual(done(evs).answered, false);
    } finally {
      m.close();
    }
  });

  it('兜底②：正文答完后尾巴上冒出标签 → 正文保留，标签截掉，算已答', async () => {
    const body = '虚拟线程由 JVM 调度，创建成本低，适合大量阻塞式 IO；平台线程一对一映射到操作系统线程，数量受限。'.repeat(3);
    const m = await startMock([{ text: body + '\n\n' + DSML }]);
    try {
      const evs = await collect(m.url);
      assert.strictEqual(text(evs).trim(), body);
      const d = done(evs);
      assert.strictEqual(d.answered, true);
      assert.ok(d.fallbackFlags.includes('textual_parse'));
    } finally {
      m.close();
    }
  });

  it('正文里普通的尖括号（泛型、比较、HTML 标签）原样保留', async () => {
    const body = 'Java 里 List<String> 和 Map<Integer, List<String>> 都是泛型写法；判断用 a < b；HTML 里写 <div> 和 <input type="text">。结尾是 a <';
    const m = await startMock([{ text: body }]);
    try {
      const evs = await collect(m.url);
      assert.strictEqual(text(evs), body);
      assert.strictEqual(done(evs).answered, true);
    } finally {
      m.close();
    }
  });

  it('splitAtToolMarkup：认出各种写法，结尾分不清的先扣着', () => {
    assert.deepStrictEqual(splitAtToolMarkup('先说两句<｜DSML｜invoke name="x">'), { emit: '先说两句', keep: '', textual: true });
    assert.deepStrictEqual(splitAtToolMarkup('<｜｜DSML｜｜ calls>'), { emit: '', keep: '', textual: true });
    assert.deepStrictEqual(splitAtToolMarkup('<| DSML |function_calls>'), { emit: '', keep: '', textual: true });
    assert.deepStrictEqual(splitAtToolMarkup('x<invoke name="read_article">'), { emit: 'x', keep: '', textual: true });
    assert.deepStrictEqual(splitAtToolMarkup('x<tool_call>{'), { emit: 'x', keep: '', textual: true });
    assert.deepStrictEqual(splitAtToolMarkup('正文<｜DS'), { emit: '正文', keep: '<｜DS', textual: false });
    assert.deepStrictEqual(splitAtToolMarkup('正文<'), { emit: '正文', keep: '<', textual: false });
    assert.deepStrictEqual(splitAtToolMarkup('List<String> 和 <div>'), { emit: 'List<String> 和 <div>', keep: '', textual: false });
    assert.deepStrictEqual(splitAtToolMarkup('<input type="text"> 后面还有很长一段正文'), {
      emit: '<input type="text"> 后面还有很长一段正文',
      keep: '',
      textual: false,
    });
  });

  it('上游报错时抛出，由调用方走降级链（不白屏）', async () => {
    // 4xx 不重试，立即抛出；5xx 会按 maxRetries=1 退避重试一次（约 2 秒），这里用 400 保持单测快速
    const m = await startMock([{ status: 400 }]);
    try {
      await assert.rejects(() => collect(m.url));
    } finally {
      m.close();
    }
  });
});

/**
 * 线上 /api/ai/chat/stream 由 server.js 直写 SSE，不经过 src/function/ai.ts。
 * 2026-11-10 发现工具循环只接在了 ai.ts 那份，线上 Iris 一直是单轮 RAG——这里直接盯 server.js。
 */
describe('线上实际处理器（server.js）接入 Iris 工具循环', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path');
  const server: string = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

  it('普通提问走 coachAgentService.streamAgentic', () => {
    assert.ok(/require\('\.\/dist\/service\/ai\/coachAgent'\)/.test(server), '未加载 CoachAgentService');
    assert.ok(/coachAgentService\.streamAgentic\(messages, context, userId\)/.test(server), '未调用 streamAgentic');
  });

  it('结构化任务与辅助调用不进工具循环', () => {
    assert.ok(/const useAgent =\s*!task &&\s*!auxModule/.test(server), 'useAgent 判定缺少 task / aux 排除');
  });

  it('status / question / citations 帧都转发给前端', () => {
    for (const k of ['status', 'question', 'citations']) {
      assert.ok(new RegExp(`JSON\\.stringify\\(\\{ ${k}: `).test(server), `缺少 ${k} 帧`);
    }
  });
});
