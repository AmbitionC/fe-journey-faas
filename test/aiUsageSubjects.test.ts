import * as assert from 'assert';
import { classifyAiSubjects } from '../src/service/growth';

/**
 * AI 用量归类的脱敏边界（2026-09-06）。
 *
 * /growth/export 是免登录的（只认 x-sync-secret），而 ai_usage_log.userId
 * 对真人就是手机号。这组用例钉住一条性质：**输出里永远不出现手机号**，
 * 无论行数据长什么样。
 */
describe('classifyAiSubjects 脱敏边界', () => {
  it('11 位手机号计入真人账号，且绝不出现在 systemIds 里', () => {
    const { bySubject, systemIds } = classifyAiSubjects([
      { id: '17394940726', calls: 3, tokens: 300 },
      { id: '13800138000', calls: 2, tokens: 200 },
    ]);
    const human = bySubject.find((s) => s.subject === '真人账号')!;
    assert.strictEqual(human.calls, 5);
    assert.strictEqual(human.tokens, 500);
    assert.strictEqual(human.distinct, 2);
    assert.deepStrictEqual(systemIds, []);
  });

  it('系统标识原样列出并按调用次数倒序', () => {
    const { bySubject, systemIds } = classifyAiSubjects([
      { id: 'eval-bot', calls: 1, tokens: 10 },
      { id: 'review', calls: 9, tokens: 900 },
      { id: 'plan-ai', calls: 5, tokens: 500 },
    ]);
    assert.deepStrictEqual(
      systemIds.map((s) => s.id),
      ['review', 'plan-ai', 'eval-bot']
    );
    const system = bySubject.find((s) => s.subject === '系统任务')!;
    assert.strictEqual(system.calls, 15);
    assert.strictEqual(system.distinct, 3);
  });

  it('混合行分别归桶，输出里搜不到任何 11 位数字串', () => {
    const { systemIds } = classifyAiSubjects([
      { id: '17394940726', calls: 1, tokens: 1 },
      { id: 'eval-bot', calls: 1, tokens: 1 },
      { id: '13800138000', calls: 1, tokens: 1 },
    ]);
    assert.ok(!/\d{11}/.test(JSON.stringify(systemIds)), '系统标识里混进了手机号');
  });

  it('空 / null / undefined 的 userId 不当成真人，显示为 (空)', () => {
    const { systemIds, bySubject } = classifyAiSubjects([
      { id: '', calls: 1, tokens: 1 },
      { id: null, calls: 1, tokens: 1 },
      { calls: 1, tokens: 1 },
    ]);
    assert.deepStrictEqual(
      systemIds.map((s) => s.id),
      ['(空)', '(空)', '(空)']
    );
    assert.strictEqual(bySubject.find((s) => s.subject === '真人账号')!.distinct, 0);
  });

  it('带国际区号/带分隔符的号码不因“不是 11 位纯数字”被当系统标识列出', () => {
    // 现网 userId 恒为 11 位手机号；万一混进别的形态，宁可少列也不能把号码列出来
    const { systemIds } = classifyAiSubjects([
      { id: '+8617394940726', calls: 1, tokens: 1 },
      { id: '173-9494-0726', calls: 1, tokens: 1 },
    ]);
    assert.ok(
      !/\d{7,}/.test(JSON.stringify(systemIds)),
      `疑似号码被原样列出：${JSON.stringify(systemIds)}`
    );
    // 仍然计数、仍然看得见「有这么个调用方」，只是不给原文
    assert.deepStrictEqual(
      systemIds.map((s) => s.id),
      ['(其他标识)', '(其他标识)']
    );
  });

  it('打印是白名单：只有系统标识长相的 id 带原文', () => {
    const { systemIds } = classifyAiSubjects([
      { id: 'eval-bot', calls: 1, tokens: 1 },
      { id: 'plan_ai2', calls: 1, tokens: 1 },
      { id: '../../etc/passwd', calls: 1, tokens: 1 },
      { id: 'a'.repeat(200), calls: 1, tokens: 1 },
      { id: 'user 17394940726', calls: 1, tokens: 1 },
    ]);
    assert.deepStrictEqual(
      systemIds.map((s) => s.id),
      ['eval-bot', 'plan_ai2', '(其他标识)', '(其他标识)', '(其他标识)']
    );
  });

  it('字符串形态的计数也能正确求和（getRawMany 返回的是字符串）', () => {
    const { bySubject } = classifyAiSubjects([
      { id: 'review', calls: '7', tokens: '700' },
      { id: 'review2', calls: '3', tokens: '300' },
    ]);
    const system = bySubject.find((s) => s.subject === '系统任务')!;
    assert.strictEqual(system.calls, 10);
    assert.strictEqual(system.tokens, 1000);
  });

  it('空输入返回两个零桶，不抛错', () => {
    const { bySubject, systemIds } = classifyAiSubjects([]);
    assert.strictEqual(bySubject.length, 2);
    assert.deepStrictEqual(systemIds, []);
    assert.strictEqual(bySubject.every((s) => s.calls === 0 && s.distinct === 0), true);
  });
});
