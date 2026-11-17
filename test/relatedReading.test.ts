import * as assert from 'assert';
import {
  interviewsAskingKnowledge,
  knowledgeInInterview,
} from '../src/common/relatedReading';

const q = (key: string, question: string) => ({ key, question, answer: '' });
const index = [
  { articleKey: 'a1', title: '字节一面', company: '字节跳动', questions: [q('rag', 'RAG 怎么召回'), q('resume', '介绍项目')] },
  { articleKey: 'a2', title: '字节二面', company: '字节跳动', questions: [q('rag', 'RAG 怎么重排')] },
  { articleKey: 'a3', title: '阿里一面', company: '阿里', questions: [q('mcp', 'MCP 是什么'), q('rag', '切片怎么做'), q('mcp', '再问 MCP')] },
];

describe('文末接着看：知识点 ↔ 面经', () => {
  it('知识点 → 面经：数总篇数，优先不同公司', () => {
    const r = interviewsAskingKnowledge(index, 'rag', 2);
    assert.strictEqual(r.total, 3);
    assert.deepStrictEqual(r.items.map(i => i.articleKey), ['a1', 'a3']);
    assert.strictEqual(r.items[1].question, '切片怎么做');
  });

  it('不同公司不够时用同公司的补齐', () => {
    const r = interviewsAskingKnowledge(index, 'rag', 3);
    assert.deepStrictEqual(r.items.map(i => i.articleKey), ['a1', 'a3', 'a2']);
  });

  it('没人问过的知识点：空', () => {
    assert.deepStrictEqual(interviewsAskingKnowledge(index, 'none'), { total: 0, items: [] });
  });

  it('面经 → 知识点：去重、跳过非技术考点和没有标题的', () => {
    const titles = new Map([
      ['rag', { title: 'RAG 概述' }],
      ['mcp', { title: 'MCP 协议' }],
      ['resume', { title: '简历' }],
    ]);
    assert.deepStrictEqual(
      knowledgeInInterview(index, 'a3', titles).map(k => k.key),
      ['mcp', 'rag']
    );
    assert.deepStrictEqual(
      knowledgeInInterview(index, 'a1', titles, new Set(['resume'])).map(k => k.key),
      ['rag']
    );
    assert.deepStrictEqual(knowledgeInInterview(index, 'missing', titles), []);
  });
});
