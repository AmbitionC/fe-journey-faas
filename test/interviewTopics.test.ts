import * as assert from 'assert';
import {
  aggregateTopics,
  buildQuestionIndex,
  FREE_TOPIC_LIMIT,
  pickExamples,
  sanitizeKeys,
} from '../src/common/interviewTopics';

const q = (key: string, text: string) =>
  `<details data-knowledge-key="${key}"><summary>${text}</summary></details>\n<p>答</p>\n`;

const navData = [
  {
    key: 'Bytedance',
    label: '字节跳动',
    children: [
      {
        key: 'bd-feishu',
        label: '飞书',
        children: [
          { key: 'bd-1', label: '字节 Agent 一面', isLeaf: true },
          { key: 'bd-2', label: '字节后端二面', isLeaf: true },
        ],
      },
    ],
  },
  {
    key: 'Tencent',
    label: '腾讯',
    children: [{ key: 'tx-1', label: '腾讯 AI 应用一面', isLeaf: true }],
  },
  {
    key: 'Meituan',
    label: '美团',
    children: [{ key: 'mt-1', label: '美团一面（正文缺失）', isLeaf: true }],
  },
];

const contents = new Map<string, string>([
  [
    'bd-1',
    q('rag-pipeline', '（1）RAG 链路怎么设计？') +
      q('rag-pipeline', '（2）追问：召回不准怎么办？') +
      q('redis-cache', '（3）缓存一致性'),
  ],
  ['bd-2', q('redis-cache', '（1）Redis 缓存击穿') + q('mysql-index', '（2）索引')],
  [
    'tx-1',
    q('rag-pipeline', '（1）介绍 RAG') +
      q('agent-memory', '（2）记忆') +
      q('mcp-protocol', '（3）MCP'),
  ],
]);

const knowledgeTitles = new Map([
  ['rag-pipeline', { title: 'RAG 完整流程' }],
  ['redis-cache', { title: 'Redis 缓存' }],
]);

describe('面经高频考点榜', () => {
  const index = buildQuestionIndex(navData, contents);

  it('按目录建索引：公司取目录第一段，没有正文或没有题的跳过', () => {
    assert.deepStrictEqual(
      index.map(a => [a.articleKey, a.company, a.questions.length]),
      [
        ['bd-1', '字节跳动', 3],
        ['bd-2', '字节跳动', 2],
        ['tx-1', '腾讯', 3],
      ]
    );
  });

  it('同一篇里同一考点只算一次，按篇数排', () => {
    const r = aggregateTopics(index, { knowledgeTitles, unlocked: true });
    assert.strictEqual(r.articlesAnalyzed, 3);
    assert.strictEqual(r.totalTopics, 5);
    const rag = r.topics[0];
    assert.strictEqual(rag.knowledgeKey, 'rag-pipeline');
    assert.strictEqual(rag.topic, 'RAG 完整流程');
    assert.strictEqual(rag.articles, 2);
    assert.deepStrictEqual(rag.companies, ['字节跳动', '腾讯']);
    // 原题每篇只取一道
    assert.deepStrictEqual(
      rag.examples.map(e => e.question),
      ['RAG 链路怎么设计？', '介绍 RAG']
    );
    assert.strictEqual(r.topics[1].knowledgeKey, 'redis-cache');
    assert.strictEqual(r.topics[1].articles, 2);
  });

  it('只统计给定的那批面经', () => {
    const r = aggregateTopics(index, {
      keys: ['tx-1'],
      knowledgeTitles,
      unlocked: true,
    });
    assert.strictEqual(r.articlesAnalyzed, 1);
    assert.deepStrictEqual(
      r.topics.map(t => t.articles),
      [1, 1, 1]
    );
  });

  it('未开通会员只有前几条带原题，其余只给考点名和篇数', () => {
    const r = aggregateTopics(index, { knowledgeTitles, unlocked: false });
    r.topics.forEach((t, i) => {
      assert.strictEqual(t.locked, i >= FREE_TOPIC_LIMIT);
      if (t.locked) assert.deepStrictEqual(t.examples, []);
      else assert.ok(t.examples.length > 0);
      assert.ok(t.articles > 0 && t.topic);
    });
    assert.ok(r.topics.some(t => t.locked));
  });

  it('原题按公司轮流挑', () => {
    const ex = (company: string, n: number) => ({
      question: `${company}${n}`,
      articleKey: `${company}-${n}`,
      title: '',
      company,
    });
    const picked = pickExamples(
      [ex('字节', 1), ex('字节', 2), ex('字节', 3), ex('腾讯', 1), ex('美团', 1)],
      4
    );
    assert.deepStrictEqual(
      picked.map(e => e.question),
      ['字节1', '腾讯1', '美团1', '字节2']
    );
  });

  it('请求里的 keys 只收合法字符串', () => {
    assert.deepStrictEqual(
      sanitizeKeys(['bd-1', 'bd-1', 3, '../x', ' tx-1 ', '']),
      ['bd-1', 'tx-1']
    );
    assert.deepStrictEqual(sanitizeKeys('bd-1'), []);
  });
});
