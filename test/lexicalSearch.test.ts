import * as assert from 'assert';
import { tokenize, lexicalSearch } from '../src/service/ai/lexicalSearch';

const leaves = [
  { module: 'knowledge', articleKey: 'debounce-throttle', title: '防抖与节流', extra: 'javascript performance' },
  { module: 'knowledge', articleKey: 'promise', title: 'Promise 详解', extra: 'javascript async' },
  { module: 'knowledge', articleKey: 'closure', title: '闭包', extra: 'javascript scope 闭包' },
  { module: 'interview', articleKey: 'tcp', title: 'TCP 三次握手', extra: 'network' },
];

describe('ai/lexicalSearch.ts', () => {
  describe('tokenize()', () => {
    it('英文按词、过滤单字符', () => {
      assert.deepStrictEqual(tokenize('async J').sort(), ['async']);
    });
    it('保留 2 字符词', () => {
      assert.deepStrictEqual(tokenize('JS').sort(), ['js']);
    });
    it('中文出单字与二元组', () => {
      const t = tokenize('防抖');
      assert.ok(t.includes('防'));
      assert.ok(t.includes('防抖'));
    });
  });

  describe('lexicalSearch()', () => {
    it('中文标题命中排首位', () => {
      const r = lexicalSearch('防抖和节流的区别', leaves, 3);
      assert.strictEqual(r[0].articleKey, 'debounce-throttle');
    });
    it('英文关键词命中 extra', () => {
      const r = lexicalSearch('promise async', leaves, 3);
      assert.strictEqual(r[0].articleKey, 'promise');
    });
    it('无匹配返回空', () => {
      assert.deepStrictEqual(lexicalSearch('zzz不存在xyz', leaves, 3), []);
    });
    it('topK 限制数量', () => {
      const r = lexicalSearch('javascript', leaves, 2);
      assert.ok(r.length <= 2);
    });
  });
});
