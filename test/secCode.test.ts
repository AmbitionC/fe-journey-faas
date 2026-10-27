import * as assert from 'assert';
import { alertChannels, normalizeSecCode } from '../src/common/secCode';

describe('normalizeSecCode 证券代码补后缀（个人记账手输代码取不到行情，2026-10-27）', () => {
  it('沪市 5/6/9 开头补 .SH', () => {
    assert.strictEqual(normalizeSecCode('510300'), '510300.SH');
    assert.strictEqual(normalizeSecCode('588000'), '588000.SH');
    assert.strictEqual(normalizeSecCode('600519'), '600519.SH');
  });
  it('深市 0/1/2/3 开头补 .SZ', () => {
    assert.strictEqual(normalizeSecCode('159915'), '159915.SZ');
    assert.strictEqual(normalizeSecCode('000001'), '000001.SZ');
    assert.strictEqual(normalizeSecCode('300750'), '300750.SZ');
  });
  it('已带后缀 / 空白 / 小写 / 其它形态原样（转大写）', () => {
    assert.strictEqual(normalizeSecCode(' 510300.sh '), '510300.SH');
    assert.strictEqual(normalizeSecCode('159915.SZ'), '159915.SZ');
    assert.strictEqual(normalizeSecCode('830799'), '830799');
    assert.strictEqual(normalizeSecCode(''), '');
    assert.strictEqual(normalizeSecCode(undefined), '');
  });
});

describe('alertChannels 推送通道是否开通（订阅页据此显示「开通中」）', () => {
  it('只认 "1"', () => {
    assert.deepStrictEqual(alertChannels({}), { email: false, wechat: false });
    assert.deepStrictEqual(alertChannels({ ALERT_MAIL_READY: '1' }), {
      email: true,
      wechat: false,
    });
    assert.deepStrictEqual(
      alertChannels({ ALERT_MAIL_READY: '', ALERT_WX_READY: '1' }),
      {
        email: false,
        wechat: true,
      }
    );
  });
});
