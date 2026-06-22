import * as assert from 'assert';
import {
  checkContent,
  healthScore,
  extractLinks,
} from '../src/service/ops/contentHealth';

describe('ops/contentHealth.ts', () => {
  describe('extractLinks()', () => {
    it('抽取 markdown 与裸链接', () => {
      const links = extractLinks('见 [文档](https://a.com/x) 和 https://b.com/y 。');
      assert.ok(links.includes('https://a.com/x'));
      assert.ok(links.includes('https://b.com/y'));
    });
  });

  describe('checkContent()', () => {
    const now = new Date('2026-01-01');

    it('过短内容标 high', () => {
      const issues = checkContent('太短了', now);
      assert.ok(issues.find((i) => i.type === 'short' && i.severity === 'high'));
    });

    it('旧年份标过时', () => {
      const body = 'x'.repeat(300) + ' 这是 2019 年的写法';
      const issues = checkContent(body, now);
      assert.ok(issues.find((i) => i.type === 'stale'));
    });

    it('TODO 标记', () => {
      const body = 'x'.repeat(300) + ' TODO: 补充示例';
      assert.ok(checkContent(body, now).find((i) => i.type === 'todo'));
    });

    it('空图片标 high', () => {
      const body = 'x'.repeat(300) + ' ![图]() ';
      assert.ok(checkContent(body, now).find((i) => i.type === 'image'));
    });

    it('外链与代码块', () => {
      const body =
        'x'.repeat(300) + ' 见 https://a.com/z \n```js\nconst a=1;\n```\n';
      const issues = checkContent(body, now);
      assert.ok(issues.find((i) => i.type === 'link'));
      assert.ok(issues.find((i) => i.type === 'codeblock'));
    });

    it('健康内容无高危问题', () => {
      const body = '这是一篇足够长且新的前端文章。'.repeat(20);
      const issues = checkContent(body, now);
      assert.ok(!issues.find((i) => i.severity === 'high'));
    });
  });

  describe('healthScore()', () => {
    it('无问题 100', () => {
      assert.strictEqual(healthScore([]), 100);
    });
    it('扣分不为负', () => {
      const s = healthScore([
        { type: 'short', severity: 'high', detail: '' },
        { type: 'image', severity: 'high', detail: '' },
        { type: 'stale', severity: 'mid', detail: '' },
        { type: 'todo', severity: 'mid', detail: '' },
        { type: 'link', severity: 'low', detail: '' },
        { type: 'codeblock', severity: 'low', detail: '' },
      ]);
      assert.ok(s >= 0 && s < 100);
    });
  });
});
