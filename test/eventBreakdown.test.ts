import * as assert from 'assert';
import { EVENT_PROP_BREAKDOWN, propValueLabel } from '../src/service/growth';

/**
 * 埋点按属性拆分（2026-11-01）。props 来自免登录的 /event/track，导出也免登录：
 * 只拆白名单里的（事件, 属性），值只放行短标识长相。
 */
describe('eventBreakdown 属性拆分', () => {
  it('白名单覆盖白屏原因、提示卡类型与 Skill 入口位置', () => {
    const keys = EVENT_PROP_BREAKDOWN.map(([e, p]) => `${e}.${p}`);
    for (const k of ['chunk_reload.kind', 'app_error_card.chunk', 'home_cta_click.placement', 'skill_entry_click.placement']) {
      assert.ok(keys.includes(k), k);
    }
  });

  it('短标识原样，缺失为「(无)」', () => {
    assert.strictEqual(propValueLabel('stale'), 'stale');
    assert.strictEqual(propValueLabel('desktop_nav'), 'desktop_nav');
    assert.strictEqual(propValueLabel('true'), 'true');
    assert.strictEqual(propValueLabel(null), '(无)');
    assert.strictEqual(propValueLabel(''), '(无)');
  });

  it('长串、带空格或像号码的值一律「(其他)」', () => {
    for (const raw of ['13800138000', 'a b', '<script>', 'x'.repeat(40), '面试']) {
      assert.strictEqual(propValueLabel(raw), '(其他)', raw);
    }
  });

  it('属性是 path 时放行站内路径，仍挡掉像号码的和非路径', () => {
    assert.strictEqual(propValueLabel('/interview/redbook-ai-21', 'path'), '/interview/redbook-ai-21');
    assert.strictEqual(propValueLabel('/membership', 'path'), '/membership');
    assert.strictEqual(propValueLabel('/u/13800138000', 'path'), '(其他)');
    assert.strictEqual(propValueLabel('https://x.com/a', 'path'), '(其他)');
    assert.strictEqual(propValueLabel('/interview/redbook-ai-21'), '(其他)');
  });

  it('渲染错误按页面拆，且只拆 kind=render 的', () => {
    const entry = EVENT_PROP_BREAKDOWN.find(([e, p]) => e === 'app_error_card' && p === 'path');
    assert.deepStrictEqual(entry && entry[2], ['kind', 'render']);
  });
});
