import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 五资产配置参考的触达文案契约（交叉验证补：Python 端提示行已有同款测试，
 * FaaS NOTE 与控制器描述此前无兜底）。
 *
 * 规则同 invest-model tests/test_allweather.py::test_hint_text_contract：
 * 触达用户的文案禁内部验证编号、禁 markdown、禁内部黑话；
 * 且必须保留「宣传收益未通过独立验证」的诚实免责句。
 */
const read = (p: string) =>
  readFileSync(join(__dirname, '..', '..', p), 'utf8');

describe('allweather 触达文案契约', () => {
  const insight = read('src/service/invest/insight.ts');
  const start = insight.indexOf('async allweather()');
  const noteBlock = insight.slice(start, insight.indexOf('const last', start));

  it('NOTE 保留诚实免责句', () => {
    assert.ok(noteBlock.includes('未能通过'));
    assert.ok(noteBlock.includes('不构成投资建议'));
  });

  it('NOTE 无内部编号 / markdown / 黑话', () => {
    assert.ok(!/[PE]\d+/.test(noteBlock), 'NOTE 出现内部验证编号');
    assert.ok(!noteBlock.includes('**'), 'NOTE 出现 markdown 加粗');
    for (const banned of ['口径', '同源', '决策日', '闸', 'invest-model']) {
      assert.ok(!noteBlock.includes(banned), `NOTE 出现黑话：${banned}`);
    }
  });

  it('控制器路由存在且为提示-only 定位', () => {
    const fn = read('src/function/invest.ts');
    assert.ok(fn.includes("path: '/invest/allweather'"));
    assert.ok(fn.includes('不参与买卖决策'));
  });

  it('auth 白名单含市场级只读放行', () => {
    const auth = read('src/middleware/auth.ts');
    assert.ok(auth.includes("path === '/invest/allweather'"));
  });
});
