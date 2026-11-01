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
});
