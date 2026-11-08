import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { runAiSdkLoop, LoopEvent } from '../src/service/ai/aisdkLoop';
import { useAiSdkEngine } from '../src/service/ai/coachAgent';

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

describe('Iris 新引擎（AI SDK）', () => {
  it('引擎开关：只有 IRIS_ENGINE=aisdk 且 provider=deepseek 才启用', () => {
    assert.strictEqual(useAiSdkEngine('deepseek', {} as any), false);
    assert.strictEqual(useAiSdkEngine('deepseek', { IRIS_ENGINE: 'aisdk' } as any), true);
    assert.strictEqual(useAiSdkEngine('deepseek', { IRIS_ENGINE: ' AISDK ' } as any), true);
    assert.strictEqual(useAiSdkEngine('dashscope', { IRIS_ENGINE: 'aisdk' } as any), false);
    assert.strictEqual(useAiSdkEngine('deepseek', { IRIS_ENGINE: 'legacy' } as any), false);
  });

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
