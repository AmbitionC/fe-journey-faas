import * as assert from 'assert';
import { ArticleQuestions } from '../src/common/interviewTopics';
import {
  normalizeSeed,
  pickInterviewPlan,
  PLAN_SIZE,
  planExhausted,
  planSources,
  splitEndMark,
} from '../src/common/mockInterviewPlan';
import {
  buildCompanyInterviewMessages,
  INTERVIEW_END_MARK,
} from '../src/service/ai/prompts';

const article = (
  articleKey: string,
  company: string,
  topics: string[]
): ArticleQuestions => ({
  articleKey,
  company,
  title: `${company} ${articleKey}`,
  questions: topics.map(key => ({
    key,
    question: `${company}问${key}`,
    answer: `${key}的要点`,
  })),
});

// 八个考点：t1 出现最多，self-intro 是「项目与职业」类
const index: ArticleQuestions[] = [
  article('a1', '字节跳动', ['t1', 't2', 't3', 'self-intro']),
  article('a2', '字节跳动', ['t1', 't2', 't4', 'self-intro']),
  article('a3', '字节跳动', ['t1', 't5', 't6']),
  article('a4', '字节跳动', ['t1', 't7', 't8']),
  article('b1', '腾讯', ['t9', 't10']),
];
const knowledgeTitles = new Map(
  ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'].map(k => [
    k,
    { title: `考点${k}` },
  ])
);
const opts = {
  keys: ['a1', 'a2', 'a3', 'a4'],
  knowledgeTitles,
  skipKeys: new Set(['self-intro']),
};

describe('mock interview plan', () => {
  it('same seed gives the same plan, different seeds can differ', () => {
    const a = pickInterviewPlan(index, { ...opts, seed: 42 });
    const b = pickInterviewPlan(index, { ...opts, seed: 42 });
    assert.deepStrictEqual(a, b);
    const plans = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map(seed =>
        pickInterviewPlan(index, { ...opts, seed })
          .questions.map(q => q.knowledgeKey)
          .join(',')
      )
    );
    assert.ok(plans.size > 1, 'seed 应该能换出不同的一场');
  });

  it('only draws from the chosen articles, skips career topics, no repeated topic', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { articlesAnalyzed, questions } = pickInterviewPlan(index, {
        ...opts,
        seed,
      });
      assert.strictEqual(articlesAnalyzed, 4);
      assert.strictEqual(questions.length, PLAN_SIZE);
      const keys = questions.map(q => q.knowledgeKey);
      assert.strictEqual(new Set(keys).size, keys.length);
      assert.ok(!keys.includes('self-intro'));
      assert.ok(questions.every(q => q.company === '字节跳动'));
      assert.ok(questions.every(q => q.topic.startsWith('考点')));
      assert.ok(questions.every(q => q.answer.endsWith('的要点')));
    }
  });

  it('caps at the number of topics available', () => {
    const plan = pickInterviewPlan(index, { ...opts, keys: ['b1'], seed: 3 });
    assert.strictEqual(plan.questions.length, 2);
    assert.deepStrictEqual(
      pickInterviewPlan(index, { ...opts, keys: ['nope'], seed: 3 }),
      { articlesAnalyzed: 0, questions: [] }
    );
  });

  it('the most asked topic is drawn more often', () => {
    let t1 = 0;
    for (let seed = 1; seed <= 200; seed++)
      if (
        pickInterviewPlan(index, { ...opts, seed, size: 1 }).questions[0]
          .knowledgeKey === 't1'
      )
        t1++;
    // t1 出现在 4 篇里，其余每个 1~2 篇：按篇数加权，t1 约占 4/12
    assert.ok(t1 > 40, `t1 只被抽到 ${t1} 次`);
  });

  it('sources leave out the questions and answers', () => {
    const { questions } = pickInterviewPlan(index, { ...opts, seed: 9 });
    for (const s of planSources(questions)) {
      assert.deepStrictEqual(Object.keys(s).sort(), [
        'articleKey',
        'company',
        'knowledgeKey',
        'title',
        'topic',
      ]);
    }
  });

  it('seed, exhaustion and end mark helpers', () => {
    assert.strictEqual(normalizeSeed(undefined), 1);
    assert.strictEqual(normalizeSeed('abc'), 1);
    assert.strictEqual(normalizeSeed(-5), 1);
    assert.strictEqual(normalizeSeed(123.7), 123);
    const turn = (role: string) => ({ role });
    const history = [
      turn('interviewer'),
      turn('candidate'),
      turn('interviewer'),
      turn('candidate'),
    ];
    assert.strictEqual(planExhausted(history, 2), false);
    assert.strictEqual(planExhausted(history, 1), true);
    assert.strictEqual(planExhausted([], 0), false);
    assert.deepStrictEqual(
      splitEndMark(`整体不错。\n${INTERVIEW_END_MARK}`, INTERVIEW_END_MARK),
      { reply: '整体不错。', finished: true }
    );
    assert.deepStrictEqual(splitEndMark('下一题', INTERVIEW_END_MARK), {
      reply: '下一题',
      finished: false,
    });
  });

  it('prompt lists the plan for the interviewer and switches to wrap-up', () => {
    const { questions } = pickInterviewPlan(index, { ...opts, seed: 5 });
    const start = buildCompanyInterviewMessages({
      label: '字节跳动 · Agent 开发',
      articlesAnalyzed: 4,
      plan: questions,
      history: [],
      finish: false,
    });
    assert.ok(start.system.includes('字节跳动 · Agent 开发'));
    assert.ok(start.system.includes('4 篇真实面经'));
    for (const q of questions) {
      assert.ok(start.system.includes(q.question));
      assert.ok(start.system.includes(q.answer));
    }
    assert.ok(start.system.includes('直接问第 1 题'));
    assert.strictEqual(start.user, '（面试开始）');
    const end = buildCompanyInterviewMessages({
      label: '字节跳动',
      articlesAnalyzed: 4,
      plan: questions,
      history: [{ role: 'candidate', content: '我的回答' }],
      finish: true,
    });
    assert.ok(end.system.includes('题已经全部问完'));
    assert.ok(end.user.includes('候选人：我的回答'));
  });
});
