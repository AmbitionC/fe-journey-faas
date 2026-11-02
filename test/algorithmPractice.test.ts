import * as assert from 'assert';
import {
  buildActivity,
  buildProblemLists,
  buildRecommendations,
  computeStreak,
  describeInterviewRefs,
  findSimilar,
  matchInterviewRefs,
  normalizeTitle,
  toDayKey,
  ProblemLite,
} from '../src/common/algorithmPractice';
import { buildReviewPrompt } from '../src/service/ai/prompts';
import type { ArticleQuestions } from '../src/common/interviewTopics';

const tag = (id: number, name: string) => ({ id: String(id), name });
const problems: ProblemLite[] = [
  { id: '1', slug: 'two-sum', title: '两数之和', difficulty: 'easy', orderNum: 1, tags: [tag(1, '数组'), tag(2, '哈希表')] },
  { id: '2', slug: 'lru', title: 'LRU 缓存', difficulty: 'medium', orderNum: 17, tags: [tag(2, '哈希表'), tag(3, '链表')] },
  { id: '3', slug: 'reverse', title: '反转链表', difficulty: 'easy', orderNum: 6, tags: [tag(3, '链表')] },
  { id: '4', slug: 'reverse-ii', title: '反转链表 II', difficulty: 'medium', orderNum: 7, tags: [tag(3, '链表')] },
  { id: '5', slug: 'lcof-03', title: '数组中重复的数字', difficulty: 'easy', orderNum: 21, tags: [tag(1, '数组'), tag(9, '剑指 Offer')] },
  { id: '6', slug: 'lcof-04', title: '二维数组中的查找', difficulty: 'medium', orderNum: 22, tags: [tag(1, '数组'), tag(9, '剑指 Offer')] },
  { id: '7', slug: 'three-sum', title: '三数之和', difficulty: 'medium', orderNum: 12, tags: [tag(1, '数组')] },
];

const index: ArticleQuestions[] = [
  {
    articleKey: 'bd-1',
    title: '字节一面',
    company: '字节跳动',
    questions: [
      { key: 'k1', question: '手写一个 LRU缓存，要求 O(1)', answer: '' },
      { key: 'k2', question: '反转链表怎么写？递归和迭代', answer: '' },
    ],
  },
  {
    articleKey: 'bd-2',
    title: '字节二面',
    company: '字节跳动',
    questions: [{ key: 'k2', question: '算法：反转链表', answer: '' }],
  },
  {
    articleKey: 'tx-1',
    title: '腾讯一面',
    company: '腾讯',
    questions: [{ key: 'k3', question: '两数之和的变体：三数之和', answer: '' }],
  },
];

describe('algorithmPractice', () => {
  it('normalizeTitle 忽略空白、标点与大小写', () => {
    assert.strictEqual(normalizeTitle('LRU 缓存'), 'lru缓存');
    assert.strictEqual(normalizeTitle(' 两数之和 '), '两数之和');
    assert.strictEqual(normalizeTitle('1～n 整数中 1 出现的次数'), '1n整数中1出现的次数');
  });

  it('matchInterviewRefs 按题名命中面经题目，同一篇只算一次，公司按篇数排序', () => {
    const refs = matchInterviewRefs(problems, index);
    assert.strictEqual(refs.get('lru')?.count, 1);
    assert.deepStrictEqual(refs.get('lru')?.companies, [{ name: '字节跳动', count: 1 }]);
    assert.strictEqual(refs.get('reverse')?.count, 2);
    assert.strictEqual(refs.get('reverse')?.examples.length, 2);
    // 「反转链表 II」去掉罗马数字后也匹配到「反转链表」
    assert.strictEqual(refs.get('reverse-ii')?.count, 2);
    // 「两数之和的变体：三数之和」同时命中两题
    assert.strictEqual(refs.get('two-sum')?.count, 1);
    assert.strictEqual(refs.get('three-sum')?.count, 1);
    assert.strictEqual(refs.get('lcof-03'), undefined);
  });

  it('toDayKey 按北京时间切日', () => {
    assert.strictEqual(toDayKey('2026-11-01T17:30:00Z'), '2026-11-02');
    assert.strictEqual(toDayKey('2026-11-01T15:59:00Z'), '2026-11-01');
  });

  it('computeStreak 今天没练时从昨天往前数，不清零', () => {
    const s = computeStreak(['2026-10-30', '2026-10-31', '2026-11-01'], '2026-11-02');
    assert.deepStrictEqual(s, { current: 3, longest: 3, practicedToday: false });
    const s2 = computeStreak(['2026-10-28', '2026-11-01', '2026-11-02'], '2026-11-02');
    assert.deepStrictEqual(s2, { current: 2, longest: 2, practicedToday: true });
    const s3 = computeStreak(['2026-10-20'], '2026-11-02');
    assert.deepStrictEqual(s3, { current: 0, longest: 1, practicedToday: false });
    assert.deepStrictEqual(computeStreak([], '2026-11-02'), {
      current: 0,
      longest: 0,
      practicedToday: false,
    });
  });

  it('buildActivity 给出按日升序、定长的热力数据', () => {
    const act = buildActivity(
      [
        { createTime: '2026-11-02T01:00:00Z', status: 'accepted' },
        { createTime: '2026-11-02T02:00:00Z', status: 'wrong_answer' },
        { createTime: '2026-10-01T02:00:00Z', status: 'accepted' },
      ],
      '2026-11-02',
      7
    );
    assert.strictEqual(act.length, 7);
    assert.strictEqual(act[0].date, '2026-10-27');
    assert.deepStrictEqual(act[6], { date: '2026-11-02', count: 2, solved: 1 });
  });

  it('buildProblemLists 自动生成面经高频 / 校招高频 / 剑指 Offer / 知识点专题', () => {
    const refs = matchInterviewRefs(problems, index);
    const lists = buildProblemLists(problems, refs);
    const slugs = lists.map(l => l.slug);
    assert.deepStrictEqual(slugs.slice(0, 3), ['interview-hot', 'campus-hot', 'sword-offer']);
    const hot = lists[0];
    // 反转链表两篇面经，排最前
    assert.strictEqual(hot.problemSlugs[0], 'reverse');
    assert.ok(!hot.problemSlugs.includes('lcof-03'));
    const campus = lists[1];
    assert.ok(!campus.problemSlugs.includes('lcof-03'));
    assert.strictEqual(campus.kind, 'builtin');
    assert.deepStrictEqual(lists[2].problemSlugs, ['lcof-03', 'lcof-04']);
    // 标签 ≥3 题才成专题：数组 4 题、链表 3 题；哈希表只有 2 题不出
    const topics = lists.filter(l => l.kind === 'topic').map(l => l.title);
    assert.deepStrictEqual(topics, ['数组', '链表']);
  });

  it('buildProblemLists 后台填了人工题单就以人工为准', () => {
    const withManual = problems.map(p =>
      p.slug === 'lru' ? { ...p, listSlugs: ['campus-hot', 'agent'] } : p
    );
    const lists = buildProblemLists(withManual, new Map());
    const campus = lists.find(l => l.slug === 'campus-hot')!;
    assert.deepStrictEqual(campus.problemSlugs, ['lru']);
    assert.strictEqual(campus.kind, 'manual');
    assert.deepStrictEqual(lists.find(l => l.slug === 'agent')?.problemSlugs, ['lru']);
    assert.strictEqual(lists.find(l => l.slug === 'interview-hot'), undefined);
  });

  it('buildRecommendations 三条规则各出一题，理由可读', () => {
    const refs = matchInterviewRefs(problems, index);
    const recs = buildRecommendations({
      problems,
      statusMap: { '1': 'accepted', '7': 'attempted' },
      flags: {},
      refs,
      lastAcceptedSlug: 'two-sum',
    });
    assert.strictEqual(recs.length, 3);
    assert.deepStrictEqual(recs.map(r => r.kind), ['redo', 'topic', 'interview']);
    assert.strictEqual(recs[0].slug, 'three-sum');
    assert.strictEqual(recs[0].reason, '上次没通过，再试一次');
    // 巩固「数组」：序号最小的未做数组题（三数之和已被规则 1 占用）
    assert.strictEqual(recs[1].slug, 'lcof-03');
    assert.ok(recs[1].reason.includes('数组'));
    assert.strictEqual(recs[2].slug, 'reverse');
    assert.strictEqual(recs[2].reason, '字节跳动 2 篇面经问过，还没做');
  });

  it('describeInterviewRefs 一家一篇不说「等」，多家只点前两家', () => {
    const one = { count: 1, companies: [{ name: '百度', count: 1 }], examples: [] };
    assert.strictEqual(describeInterviewRefs(one), '百度的面经问过');
    const many = {
      count: 3,
      companies: [
        { name: '字节跳动', count: 1 },
        { name: '腾讯', count: 1 },
        { name: '百度', count: 1 },
      ],
      examples: [],
    };
    assert.strictEqual(describeInterviewRefs(many), '字节跳动、腾讯等 3 篇面经问过');
    assert.strictEqual(
      describeInterviewRefs({ count: 2, companies: [], examples: [] }),
      '2 篇面经问过'
    );
  });

  it('buildRecommendations 访客 / 新用户也有推荐：面经高频 + 顺序', () => {
    const refs = matchInterviewRefs(problems, index);
    const recs = buildRecommendations({ problems, statusMap: {}, flags: {}, refs });
    assert.strictEqual(recs.length, 3);
    assert.strictEqual(recs[0].kind, 'interview');
    assert.ok(recs.slice(1).every(r => r.kind === 'next'));
    assert.strictEqual(new Set(recs.map(r => r.slug)).size, 3);
  });

  it('findSimilar 按共享标签数与序号就近', () => {
    const sim = findSimilar(problems[0], problems).map(p => p.slug);
    // 哈希表+数组：LRU 共享哈希表、三数之和 / lcof 共享数组；排除剑指 Offer 集合标签不影响
    assert.ok(sim.includes('lru'));
    assert.ok(sim.includes('three-sum'));
    assert.ok(!sim.includes('two-sum'));
    assert.strictEqual(sim.length, 4);
  });

  it('buildReviewPrompt 带失败用例时聚焦找错因', () => {
    const { system, user } = buildReviewPrompt({
      title: '两数之和',
      code: 'return []',
      language: 'javascript',
      focus: 'bug',
      resultSummary: '通过 0/3',
      failingCase: {
        input: '[2,7,11,15]\n9',
        expectedOutput: '[0,1]',
        actualOutput: '[]',
        error: null,
      },
    });
    assert.ok(system.includes('最可能的错因'));
    assert.ok(user.includes('未通过的用例'));
    assert.ok(user.includes('实际输出：[]'));
    assert.ok(user.endsWith('请帮我找出错在哪里。'));
    const opt = buildReviewPrompt({ title: 't', code: 'c', focus: 'optimize' });
    assert.ok(opt.system.includes('核心观察'));
    const plain = buildReviewPrompt({ title: 't', code: 'c' });
    assert.ok(plain.user.endsWith('请给出点评。'));
  });
});
