import * as assert from 'assert';
import { pricing } from '../src/mcp/selfServe';
import { IRIS_COST, REFERRAL_REWARD } from '../src/mcp/billing';
import { readUsage, SseLineBuffer } from '../src/service/ai/proxy';
import { parseReportJson, sharedView } from '../src/service/ai/irisReport';
import { buildInterviewReportMessages } from '../src/service/ai/prompts';

describe('Iris 对外契约', () => {
  it('/mcp/pricing 带 iris 与 referral 两段（前端不写死数字）', () => {
    const p = pricing(new Date('2026-11-02T00:00:00Z'), true, 5000, 'agent') as any;
    assert.deepStrictEqual(p.iris.costs, IRIS_COST);
    assert.ok(Array.isArray(p.iris.memberOnly));
    assert.ok(typeof p.iris.freeDaily === 'number');
    assert.strictEqual(p.referral.inviter, REFERRAL_REWARD.inviter);
    assert.strictEqual(p.referral.memberBonus, REFERRAL_REWARD.memberBonus);
    assert.strictEqual(p.referral.monthlyCap, REFERRAL_REWARD.monthlyCap);
  });

  it('usage 归一化：DeepSeek 缓存命中 / 思考 token', () => {
    const u = readUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 30 },
    });
    assert.strictEqual(u.totalTokens, 150);
    assert.strictEqual(u.cacheHitTokens, 80);
    assert.strictEqual(u.reasoningTokens, 30);
    assert.strictEqual(readUsage({ input_tokens: 3, output_tokens: 4 }).totalTokens, 7);
    assert.strictEqual(readUsage(undefined).totalTokens, 0);
  });

  it('SSE 行缓冲：跨 chunk 的半行拼回去，[DONE] 原样透出', () => {
    const b = new SseLineBuffer();
    assert.deepStrictEqual(b.push('data: {"a":'), []);
    assert.deepStrictEqual(b.push('1}\n\ndata: [DO'), ['{"a":1}']);
    assert.deepStrictEqual(b.push('NE]\n'), ['[DONE]']);
    assert.deepStrictEqual(b.push(': keep-alive\ndata: x'), []);
    assert.deepStrictEqual(b.flush(), ['x']);
  });

  it('报告 JSON 解析：容忍 ```json 围栏，越界分数截断，分享视图不含原题', () => {
    const raw = '```json\n' + JSON.stringify({
      score: 130,
      verdict: '基础扎实',
      level: '中级',
      strengths: ['闭包讲得清楚'],
      weaknesses: ['事件循环漏了微任务'],
      perQuestion: [{ question: '说说闭包', topic: 'JS 基础', performance: '完整', keyPoint: '词法作用域', score: 12 }],
      reviewTopics: ['事件循环'],
      nextSteps: ['做 3 道事件循环题'],
    }) + '\n```';
    const r = parseReportJson(raw);
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.perQuestion[0].score, 10);
    const shared = sharedView(
      { id: 1, code: 'abc', user_id: 'u', label: '字节 · 前端', topic: null, question_count: 1, score: 100, report: '', model: null, created_at: 'x' },
      r
    ) as any;
    assert.strictEqual(JSON.stringify(shared).includes('说说闭包'), false);
    assert.strictEqual(shared.perQuestion[0].topic, 'JS 基础');
    assert.deepStrictEqual(shared.reviewTopics, ['事件循环']);
    assert.throws(() => parseReportJson('not json at all'));
  });

  it('报告提示词：要求 JSON、带对话与题单', () => {
    const { system, user } = buildInterviewReportMessages({
      label: '字节 · Agent',
      history: [
        { role: 'interviewer', content: '第一题' },
        { role: 'candidate', content: '我的回答' },
      ],
      plan: [{ topic: 'RAG', question: '原题一' }],
    });
    assert.ok(/JSON/.test(system) && /perQuestion/.test(system));
    assert.ok(user.includes('候选人：我的回答') && user.includes('[RAG] 原题一'));
  });
});
