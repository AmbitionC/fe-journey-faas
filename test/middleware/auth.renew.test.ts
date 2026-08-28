import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 登录态滑动续期契约（2026-08-28 整站「请求失败」复盘的根因①回归测试）。
 *
 * 旧行为：token 只在登录时写一次、TTL 7 天、任何请求都不续期 ⟹ 活跃用户也会在
 * 第 7 天被集体登出（两位用户同晨全部 401）。本测试对旧版 auth.ts 失败（先红），
 * 修复（每次有效 token 请求重置 TTL）后通过（后绿）。
 */
const src = readFileSync(
  join(__dirname, '..', '..', 'src', 'middleware', 'auth.ts'),
  'utf8',
);

describe('auth 中间件登录态滑动续期', () => {
  it('定义了基于 token 配置 TTL 的续期方法', () => {
    assert.ok(/private renew\(/.test(src), '缺少 renew 方法');
    assert.ok(src.includes("@Config('token')"), '续期 TTL 必须来自 token 配置真源');
  });

  it('invest 强制鉴权与非 invest 尽力解析两条命中分支都续期', () => {
    const calls = src.match(/this\.renew\(token\)/g) || [];
    assert.ok(calls.length >= 2, `renew 调用应覆盖两条分支，实际 ${calls.length} 处`);
  });

  it('续期失败静默，不影响本次请求', () => {
    assert.ok(/expire\([^)]*\)\.catch\(/.test(src), '续期必须 fail-soft（.catch 吞错）');
  });
});
