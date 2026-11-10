import * as assert from 'assert';
import { CoachToolsService, pickInterviewQuestions } from '../src/service/ai/coachTools';
import { buildMemoryPrompt, statusLabel, titleFromCitations } from '../src/service/ai/coachAgent';

const INDEX = [
  {
    articleKey: 'bytedance-agent-1',
    title: '字节 Agent 一面',
    company: '字节跳动',
    questions: [
      { key: 'rag', question: 'RAG 的召回怎么评估？', answer: '召回率 + 人工标注集' },
      { key: 'fc', question: 'Function Calling 失败怎么兜底？', answer: '' },
      { key: 'rag-2', question: 'RAG 分块策略？', answer: '' },
    ],
  },
  {
    articleKey: 'ali-llm-2',
    title: '阿里 大模型应用 二面',
    company: '阿里巴巴',
    questions: [{ key: 'rag', question: 'RAG 和微调怎么选？', answer: '看知识更新频率' }],
  },
];

function ctx(userId = 'u1') {
  return { userId, module: 'knowledge', citations: new Map() } as any;
}

function repo(rows: any[]) {
  return {
    find: async () => rows,
    findOne: async () => rows[0] || null,
  } as any;
}

describe('Iris 阶段 2 工具', () => {
  it('面经挑题：公司 + 考点同时过滤，同一篇最多 2 题', () => {
    const all = pickInterviewQuestions(INDEX, '', 'rag', 10);
    assert.deepStrictEqual(
      all.map((q) => q.question),
      ['RAG 的召回怎么评估？', 'RAG 分块策略？', 'RAG 和微调怎么选？']
    );
    const ali = pickInterviewQuestions(INDEX, '阿里', 'rag', 10);
    assert.strictEqual(ali.length, 1);
    assert.strictEqual(ali[0].company, '阿里巴巴');
    assert.strictEqual(pickInterviewQuestions(INDEX, '腾讯', '', 10).length, 0);
    assert.strictEqual(pickInterviewQuestions(INDEX, '', '', 2).length, 2);
  });

  it('get_interview_bank 返回题目并把出处面经放进引用', async () => {
    const svc = new CoachToolsService();
    (svc as any).questionIndex = { load: async () => ({ index: INDEX }) };
    const c = ctx();
    const out = await svc.execute('get_interview_bank', { company: '字节', topic: 'RAG' }, c);
    assert.ok(out.includes('RAG 的召回怎么评估？'));
    assert.ok(out.includes('召回率'));
    assert.ok(c.citations.has('interview:bytedance-agent-1'));
  });

  it('get_mission_context：游客不查库；进行中的题带验收标准、未通过项和补课清单', async () => {
    const svc = new CoachToolsService();
    assert.ok((await svc.execute('get_mission_context', {}, ctx('guest:1.2.3.4'))).includes('游客'));

    (svc as any).submissionModel = repo([
      { id: 7, missionId: 3, missionSlug: 'anti-spam', status: 'rework', reworkCount: 1, planFeedback: '缺评测集' },
    ]);
    (svc as any).missionModel = repo([
      {
        id: 3,
        title: '评论反垃圾',
        summary: '做一个评论审核 Agent',
        requirements: ['识别广告', '给出理由'],
        acceptanceCriteria: [{ id: 'A1', text: '8 条测试对话全部通过', mustPass: true }],
        prereqArticles: [{ module: 'llm', key: 'eval-basics', title: '评测入门' }],
      },
    ]);
    (svc as any).reviewModel = repo([
      {
        verdict: 'rework',
        totalScore: 62,
        criteriaVerdicts: [
          { id: 'A1', text: '8 条测试对话全部通过', verdict: 'fail', note: '第 5 条误判' },
          { id: 'A2', text: '有日志', verdict: 'pass' },
        ],
        makeupArticles: [{ module: 'llm', key: 'prompt-guard', title: '提示词防注入' }],
      },
    ]);
    const c = ctx();
    const out = await svc.execute('get_mission_context', {}, c);
    assert.ok(out.includes('评论反垃圾'));
    assert.ok(out.includes('需返工'));
    assert.ok(out.includes('[A1] 8 条测试对话全部通过（必过）'));
    assert.ok(out.includes('第 5 条误判'));
    assert.ok(!out.includes('有日志'), '已通过的验收项不该列进未通过');
    assert.ok(out.includes('缺评测集'));
    assert.ok(c.citations.has('llm:prompt-guard'));
    assert.ok(c.citations.has('llm:eval-basics'));
  });

  it('schedule_review 幂等：已在计划里不改动；游客和未知模块直接拒绝', async () => {
    const svc = new CoachToolsService();
    let calls = 0;
    const due = Date.UTC(2026, 10, 12, 1);
    (svc as any).articleService = {
      ensureSchedule: async () => ({ dueAt: due, created: calls++ === 0 }),
    };
    assert.ok((await svc.execute('schedule_review', { module: 'knowledge', key: 'debounce' }, ctx())).includes('已加入复习计划，11月12日'));
    assert.ok((await svc.execute('schedule_review', { module: 'knowledge', key: 'debounce' }, ctx())).includes('已经在复习计划里'));
    assert.ok((await svc.execute('schedule_review', { module: 'knowledge', key: 'x' }, ctx('guest:1'))).includes('游客'));
    assert.ok((await svc.execute('schedule_review', { module: 'nope', key: 'x' }, ctx())).includes('未知模块'));
    assert.strictEqual(calls, 2);
  });

  it('qa 模式默认工具里包含新工具，不含 ask_question', () => {
    const svc = new CoachToolsService();
    const names = svc.getToolDefs().map((t) => t.function.name);
    for (const n of ['get_mission_context', 'get_interview_bank', 'schedule_review']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('ask_question'));
  });

  it('跨会话记忆：只列标题，过滤「新对话」；没有记录返回空串', () => {
    const now = Date.UTC(2026, 10, 10, 8);
    const p = buildMemoryPrompt(
      [
        { title: '防抖怎么实现', lastMessageAt: new Date(now - 86400000) },
        { title: '新对话', lastMessageAt: new Date(now) },
        { title: 'RAG 召回率低怎么办', lastMessageAt: new Date(now - 3 * 86400000) },
      ],
      now
    );
    assert.ok(p.includes('- 昨天：防抖怎么实现'));
    assert.ok(p.includes('- 3 天前：RAG 召回率低怎么办'));
    assert.ok(!p.includes('新对话'));
    assert.ok(p.includes('上次你问过'));
    assert.strictEqual(buildMemoryPrompt([], now), '');
  });

  it('查阅状态显示文章标题而不是英文 key', () => {
    const label = statusLabel('read_article', { module: 'llm', key: 'agent-run-loop', section: '终止条件' }, () => 'Agent Run Loop、轮次与终止条件');
    assert.strictEqual(label, '正在查阅《Agent Run Loop、轮次与终止条件》 · 终止条件…');
    assert.strictEqual(statusLabel('read_article', { key: 'x' }), '正在查阅《x》…');
  });

  it('标题兜底：module 写错时按 key 匹配', () => {
    const m = new Map([['llm:agent-run-loop', { module: 'llm', articleKey: 'agent-run-loop', title: 'Agent Run Loop' }]]);
    assert.strictEqual(titleFromCitations(m as any, 'knowledge', 'agent-run-loop'), 'Agent Run Loop');
    assert.strictEqual(titleFromCitations(m as any, 'llm', 'nope'), undefined);
  });
});
