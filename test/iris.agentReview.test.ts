import * as assert from 'assert';
import { normalizeAgentVerdict, summarizeRun } from '../src/service/review/agentReview';

const CRIT = [
  { id: '1', text: '提取 JSON', mustPass: true },
  { id: '2', text: '校验', mustPass: false },
];

describe('作业评审 Agent', () => {
  it('必过项 fail 时强制 rework，分数夹到区间内', () => {
    const r = normalizeAgentVerdict(
      '```json\n{"verdict":"pass","totalScore":180,"scores":{"correctness":70,"process":10,"quality":5},' +
        '"criteriaVerdicts":[{"id":"1","verdict":"fail","note":"代码块解析失败","evidence":"run_code 输出 null"},{"id":"2","verdict":"maybe"}],"report":"x"}\n```',
      CRIT
    )!;
    assert.strictEqual(r.verdict, 'rework');
    assert.strictEqual(r.totalScore, 100);
    assert.strictEqual(r.scores.correctness, 50);
    assert.strictEqual(r.criteriaVerdicts[1].verdict, 'uncertain');
    assert.strictEqual(r.criteriaVerdicts[0].evidence, 'run_code 输出 null');
  });

  it('结论无法解析返回 null（调用方转 need_human）', () => {
    assert.strictEqual(normalizeAgentVerdict('我觉得挺好', CRIT), null);
    assert.strictEqual(normalizeAgentVerdict('{"verdict":"great"}', CRIT), null);
  });

  it('运行结果摘要去掉 Node 内部堆栈', () => {
    const s = summarizeRun({ exitCode: 1, stdout: '', stderr: 'node:assert:1\nAssertionError: x\n    at node:internal/foo\n    at Object.<anonymous> (main.js:1:1)\nNode.js v22' });
    assert.ok(s.includes('AssertionError: x'));
    assert.ok(!s.includes('node:internal'));
    assert.ok(s.includes('main.js:1:1'));
    assert.ok(summarizeRun({ error: '502' }).includes('不可用'));
  });

  it('运行器能带上仓库文件一起跑，并挡掉越界路径', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runCode, safeRelPath } = require('../runner/code-runner/server.js');
    assert.strictEqual(safeRelPath('../x.js'), null);
    assert.strictEqual(safeRelPath('/etc/passwd'), null);
    assert.strictEqual(safeRelPath('src/a.js'), 'src/a.js');
    const r = await runCode({
      code: 'const { add } = require("./src/math.js"); console.log(add(2, 3))',
      files: { 'src/math.js': 'exports.add = (a, b) => a + b', '../evil.js': 'x' },
    });
    assert.strictEqual(r.stdout.trim(), '5');
  });
});

describe('评审主路径切到 Agent', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ReviewService } = require('../src/service/review');

  function makeSvc(agentResult: any) {
    const svc = new ReviewService();
    const saved: any[] = [];
    const sub: any = { id: 7, missionId: 1, userId: 'u1', status: 'submitted', repoUrl: 'https://github.com/a/b', retro: {} };
    svc.submissionModel = { findOne: async () => sub, save: async (x: any) => x };
    svc.missionModel = {
      findOne: async () => ({ id: 1, title: 't', acceptanceCriteria: [{ id: '1', text: 'x', mustPass: true }] }),
    };
    svc.reviewModel = { create: (x: any) => x, save: async (x: any) => (saved.push(x), { ...x, id: 99 }) };
    svc.skillModel = { create: (x: any) => x, save: async () => [] };
    svc.metricsService = { track: async () => {} };
    svc.readRepo = async () => ({ digest: 'd', snapshot: { fileCount: 3 }, tree: { owner: 'a', repo: 'b', branch: 'main', files: [] } });
    svc.agentGrade = async () => agentResult;
    let oldCalled = 0;
    svc.gradeWithLLM = async () => {
      oldCalled++;
      return { verdict: 'pass', totalScore: 70, scores: {}, criteriaVerdicts: [], report: 'old', skills: null };
    };
    return { svc, saved, sub, oldCalled: () => oldCalled };
  }

  it('Agent 成功：用 Agent 结论，记录运行统计，不调旧评审', async () => {
    const t = makeSvc({
      verdict: 'rework', totalScore: 40, scores: {}, report: 'agent', skills: null,
      criteriaVerdicts: [{ id: '1', verdict: 'fail', note: '', evidence: 'ran' }],
      runs: 2, runsOk: 2, filesRead: 3, steps: 5, tokenUsed: 100, ms: 1000,
    });
    await t.svc.runReview(7);
    assert.strictEqual(t.oldCalled(), 0);
    assert.strictEqual(t.saved[0].verdict, 'rework');
    assert.strictEqual(t.saved[0].report, 'agent');
    assert.ok(String(t.saved[0].reviewerModel).startsWith('agent:'));
    assert.strictEqual(t.saved[0].repoSnapshot.agent.runs, 2);
    assert.strictEqual(t.sub.status, 'rework');
  });

  it('Agent 失败或不可用：退回旧评审，并记下失败原因', async () => {
    const t = makeSvc({ error: 'timeout' });
    await t.svc.runReview(7);
    assert.strictEqual(t.oldCalled(), 1);
    assert.strictEqual(t.saved[0].report, 'old');
    assert.strictEqual(t.saved[0].repoSnapshot.agentError, 'timeout');
    const t2 = makeSvc(null);
    await t2.svc.runReview(7);
    assert.strictEqual(t2.oldCalled(), 1);
  });
});
