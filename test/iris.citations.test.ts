import * as assert from 'assert';
import { selectCitations } from '../src/service/ai/coachAgent';

const CANDIDATES = [
  { module: 'soe', articleKey: 'soe-java-mcq', title: 'Java 基础常考点：面向对象、异常、集合与常见陷阱' },
  { module: 'knowledge', articleKey: 'few-shot', title: 'Few-Shot 提示词设计' },
  { module: 'soe', articleKey: 'soe-os-mcq', title: '操作系统选择题高频考点' },
  { module: 'interview', articleKey: 'bytedance-ai-fe', title: '字节 AI 前端一面' },
  { module: 'soe', articleKey: 'soe-untitled', title: 'soe-untitled' },
];

describe('Iris 延伸阅读挑选', () => {
  it('只列回答正文里提到标题的文章', () => {
    const answer = '这题考引用语义。\n\n延伸阅读：《Java 基础常考点：面向对象、异常、集合与常见陷阱》';
    assert.deepStrictEqual(
      selectCitations(CANDIDATES, answer, 'soe').map((c) => c.articleKey),
      ['soe-java-mcq']
    );
  });

  it('跨模块的文章只要回答里真引用了就保留', () => {
    const answer = '可以对照《Few-Shot 提示词设计》和《操作系统选择题高频考点》。';
    assert.deepStrictEqual(
      selectCitations(CANDIDATES, answer, 'soe').map((c) => c.articleKey),
      ['few-shot', 'soe-os-mcq']
    );
  });

  it('一篇都没提到时只留当前模块的前 3 篇，不带别的方向，也不带只有 slug 的', () => {
    assert.deepStrictEqual(
      selectCitations(CANDIDATES, '直接讲解，没有引用。', 'soe').map((c) => c.articleKey),
      ['soe-java-mcq', 'soe-os-mcq']
    );
    assert.deepStrictEqual(selectCitations(CANDIDATES, '', 'civil'), []);
  });

  it('标题太短（不足 4 个字）不按「提到」算，免得回答里随口一个词就把别的方向带进来', () => {
    const short = [{ module: 'knowledge', articleKey: 'rag', title: 'RAG' }];
    assert.deepStrictEqual(selectCitations(short, '这和 RAG 没什么关系。', 'soe'), []);
  });

  it('最多 6 篇', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      module: 'soe',
      articleKey: `k${i}`,
      title: `第 ${i} 篇文章标题`,
    }));
    const answer = many.map((c) => `《${c.title}》`).join('');
    assert.strictEqual(selectCitations(many, answer, 'soe').length, 6);
  });
});
