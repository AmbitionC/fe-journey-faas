/**
 * 正文入库标题为空（央国企 / 考公文章标题只写在 _tree.json）时，
 * Iris 的思考行和「延伸阅读」不能把英文 slug 给用户看，要按目录树补标题。
 */
import * as assert from 'assert';
import {
  ArticleContentService,
  needsTitle,
} from '../src/service/content/articleContent';

function makeService(rows: Record<string, any>, nav: any[]) {
  const svc = new ArticleContentService();
  let navReads = 0;
  (svc as any).contentModel = {
    findOne: async ({ where }: any) => rows[`${where.module}:${where.articleKey}`] ?? null,
  };
  (svc as any).navConfigModel = {
    findOneBy: async () => {
      navReads++;
      return { navData: nav };
    },
  };
  return { svc, navReads: () => navReads };
}

const NAV = [
  {
    key: 'g',
    label: '自测卷',
    children: [
      { key: 'soe-cs-self-test-b', label: '计算机专业综合自测 B 卷', isLeaf: true },
      { key: 'no-label', isLeaf: true },
    ],
  },
];

describe('ArticleContentService 标题兜底', () => {
  it('needsTitle：空标题或等于 slug 时需要补', () => {
    assert.strictEqual(needsTitle('', 'a'), true);
    assert.strictEqual(needsTitle(null, 'a'), true);
    assert.strictEqual(needsTitle('a', 'a'), true);
    assert.strictEqual(needsTitle('RAG 完整流程实战', 'rag-pipeline'), false);
  });

  it('get：标题为空时用目录里的标题，并缓存目录', async () => {
    const { svc, navReads } = makeService(
      { 'soe:soe-cs-self-test-b': { articleKey: 'soe-cs-self-test-b', title: '', content: 'x' } },
      NAV
    );
    const row = await svc.get('soe', 'soe-cs-self-test-b');
    assert.strictEqual(row?.title, '计算机专业综合自测 B 卷');
    await svc.get('soe', 'soe-cs-self-test-b');
    assert.strictEqual(navReads(), 1);
  });

  it('get：已有标题不覆盖；目录里也没有时保持原样', async () => {
    const { svc } = makeService(
      {
        'soe:keep': { articleKey: 'keep', title: '原标题', content: 'x' },
        'soe:no-label': { articleKey: 'no-label', title: '', content: 'x' },
      },
      NAV
    );
    assert.strictEqual((await svc.get('soe', 'keep'))?.title, '原标题');
    assert.strictEqual((await svc.get('soe', 'no-label'))?.title, '');
  });
});
