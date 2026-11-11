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
