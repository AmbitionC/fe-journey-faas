import * as assert from 'assert';
import {
  AGENT_STACK,
  isAgentStackTerm,
  joinRolePhrases,
  roleGroupOf,
} from '../src/common/interviewRoles';
import { matchInterviews, navIndex, topicTerms } from '../src/mcp/tools/agent';

describe('面经岗位分类（与网站同一规则）', () => {
  it('Agent 开发、AI 应用开发、AI 全栈 / 前端都归 Agent 全栈研发', () => {
    for (const title of [
      '字节 AI 全栈实习一面：多 Agent 编排',
      '哔哩哔哩 AI 应用岗 Agent 开发一面',
      '字节豆包 Seed Agent 开发一面：状态与评测',
      '快手前端一面：流式渲染',
    ])
      assert.strictEqual(roleGroupOf({ title }), AGENT_STACK, title);
    assert.strictEqual(roleGroupOf({ title: '小红书 Agent 算法一面：研究停止' }), '算法');
    assert.strictEqual(roleGroupOf({ title: '美团后端 AI 一面：工具恢复' }), '后端');
    assert.strictEqual(roleGroupOf({ title: '百度 AI 测开一面：LLM 评测' }), '其他');
    // 题目里的词不算岗位
    assert.strictEqual(roleGroupOf({ title: '腾讯 WXG 一面：跨语言 RAG 与 Agent' }), '其他');
    assert.strictEqual(
      roleGroupOf({ title: '腾讯 AI 后端实习面经：编排', role: 'AI 应用开发后端（实习）' }),
      AGENT_STACK
    );
    assert.strictEqual(roleGroupOf({ title: '字节一面：线程池', roleGroup: 'AI 应用开发' }), AGENT_STACK);
  });

  it('检索词：新名、三个旧名、单写「全栈」都指这一类；带空格的岗位名先并成一个词', () => {
    for (const t of ['Agent全栈研发', 'agent全栈', '全栈', '全栈研发', 'AI全栈', 'AI应用开发', 'Agent开发'])
      assert.ok(isAgentStackTerm(t), t);
    for (const t of ['agent', '前端', '后端', '全栈实习', 'ai'])
      assert.ok(!isAgentStackTerm(t), t);
    assert.strictEqual(joinRolePhrases('字节 Agent 全栈研发'), '字节 Agent全栈研发');
    assert.strictEqual(joinRolePhrases('字节 AI 应用开发 二面'), '字节 AI应用开发 二面');
    // 只并整段：「AI 全栈实习」保持原样，才能和标题里的「AI 全栈实习」对上
    assert.strictEqual(joinRolePhrases('字节 AI 全栈实习'), '字节 AI 全栈实习');
    assert.deepStrictEqual(topicTerms('字节 Agent 全栈研发最常问什么'), ['字节', 'Agent全栈研发']);
  });

  it('interview_topics 按岗位分类匹配，不要求标题一字不差', () => {
    const nav = navIndex([
      {
        label: '字节跳动',
        children: [
          { key: 'b1', label: '字节 Agent 开发一面：上下文', isLeaf: true },
          { key: 'b2', label: '字节 AI 应用开发二面：RAG', isLeaf: true },
          { key: 'b3', label: '字节 AI 全栈实习一面：Top-K', isLeaf: true },
          { key: 'b4', label: '字节后端一面：MySQL', isLeaf: true },
          { key: 'b5', label: '字节 Agent 算法一面：RL', isLeaf: true },
          { key: 'b6', label: '字节一面：线程池', isLeaf: true, role: 'Agent 开发（实习）' },
        ],
      },
      { label: '腾讯', children: [{ key: 't1', label: '腾讯 Agent 一面：记忆', isLeaf: true }] },
    ]);
    const all = ['b1', 'b2', 'b3', 'b6'];
    assert.deepStrictEqual(matchInterviews(nav, topicTerms('字节 Agent 全栈研发')), all);
    assert.deepStrictEqual(matchInterviews(nav, topicTerms('字节全栈')), all);
    assert.deepStrictEqual(matchInterviews(nav, topicTerms('字节 AI 应用开发')), all);
    // 普通词照旧按标题匹配
    assert.deepStrictEqual(matchInterviews(nav, topicTerms('字节 后端')), ['b4']);
    assert.deepStrictEqual(matchInterviews(nav, topicTerms('字节 AI 全栈实习')), ['b3']);
    assert.deepStrictEqual(matchInterviews(nav, topicTerms('Agent 全栈研发')), [...all, 't1']);
  });
});
