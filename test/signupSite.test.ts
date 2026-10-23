import * as assert from 'assert';
import { beijingDay, siteFromOrigin } from '../src/common/signupSite';

describe('siteFromOrigin 注册来源站点', () => {
  it('两个正式站点', () => {
    assert.strictEqual(siteFromOrigin('https://invest-journey.cn'), 'invest');
    assert.strictEqual(siteFromOrigin('https://www.invest-journey.cn'), 'invest');
    assert.strictEqual(siteFromOrigin('https://www.agent-journey.cn'), 'agent');
    assert.strictEqual(siteFromOrigin('https://agent-journey.cn'), 'agent');
  });

  it('预览 / 本地 / 其它', () => {
    assert.strictEqual(siteFromOrigin('https://invest-journey-git-x.vercel.app'), 'preview');
    assert.strictEqual(siteFromOrigin('http://localhost:8000'), 'local');
    assert.strictEqual(siteFromOrigin('https://evil-invest-journey.cn.example.com'), 'other');
    assert.strictEqual(siteFromOrigin(''), 'other');
    assert.strictEqual(siteFromOrigin(undefined), 'other');
    assert.strictEqual(siteFromOrigin('not a url'), 'other');
  });
});

describe('beijingDay 北京日期', () => {
  it('UTC 16:00 已是北京次日', () => {
    assert.strictEqual(beijingDay(Date.UTC(2026, 9, 23, 15, 59)), '20261023');
    assert.strictEqual(beijingDay(Date.UTC(2026, 9, 23, 16, 0)), '20261024');
  });
});
