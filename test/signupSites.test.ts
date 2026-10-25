import * as assert from 'assert';
import { countSignupSites } from '../src/service/growth';

/**
 * 注册按站点计数（2026-10-25）：invest-journey 与本站共用 user 表，
 * 复盘只该数本站的注册。来源记录 2026-10-23 才开始有。
 */
describe('countSignupSites 注册站点拆分', () => {
  it('按来源记录归站点，没有记录的归 unrecorded', () => {
    const out = countSignupSites(
      ['13800000001', '13800000002', '13800000003', '13800000004'],
      [
        { id: '13800000001', site: 'agent' },
        { id: '13800000002', site: 'invest' },
        { id: '13800000003', site: 'invest' },
      ]
    );
    assert.deepStrictEqual(out, { agent: 1, invest: 2, preview: 0, local: 0, other: 0, unrecorded: 1 });
  });

  it('未知站点值归 other；重复 id 只算一次', () => {
    const out = countSignupSites(
      ['13800000001', '13800000001', '13800000002'],
      [
        { id: '13800000001', site: 'preview' },
        { id: '13800000002', site: 'somewhere' },
      ]
    );
    assert.deepStrictEqual(out, { agent: 0, invest: 0, preview: 1, local: 0, other: 1, unrecorded: 0 });
  });

  it('输出只有计数，不含任何号码', () => {
    const out = countSignupSites(['13800000001'], [{ id: '13800000001', site: 'agent' }]);
    assert.ok(!/\d{7,}/.test(JSON.stringify(out)));
  });
});
