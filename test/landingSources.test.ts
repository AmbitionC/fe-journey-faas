import * as assert from 'assert';
import { landingSourceLabel } from '../src/service/growth';

/**
 * 进站来源展示名的脱敏边界（2026-10-18）。
 *
 * `props.ref` 来自免登录的 /event/track，谁都能写；/growth/export 也是免登录的
 * （只认 x-sync-secret）。这组用例钉住：**导出里只会出现主机名长相的字符串**。
 */
describe('landingSourceLabel 脱敏边界', () => {
  it('空值是无来源（直接打开 / 书签 / 微信内打开）', () => {
    assert.strictEqual(landingSourceLabel(''), '(无来源)');
    assert.strictEqual(landingSourceLabel(null), '(无来源)');
    assert.strictEqual(landingSourceLabel(undefined), '(无来源)');
    assert.strictEqual(landingSourceLabel('   '), '(无来源)');
  });

  it('主机名统一小写并去掉 www.，让 www 与裸域归到一起', () => {
    assert.strictEqual(landingSourceLabel('WWW.Baidu.com'), 'baidu.com');
    assert.strictEqual(landingSourceLabel('baidu.com'), 'baidu.com');
    assert.strictEqual(landingSourceLabel('m.baidu.com'), 'm.baidu.com');
    assert.strictEqual(landingSourceLabel('juejin.cn'), 'juejin.cn');
  });

  it('不像主机名的一律归「(其他)」，不原样输出', () => {
    for (const raw of [
      '17394940726',
      '17394940726.com',
      'https://www.google.com/search?q=x',
      'baidu.com/s?wd=面试',
      '张三.com',
      'localhost',
      'a'.repeat(70) + '.com',
      '<script>.com',
    ]) {
      assert.strictEqual(landingSourceLabel(raw), '(其他)', raw);
    }
  });
});
