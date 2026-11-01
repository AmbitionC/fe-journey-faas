import * as assert from 'assert';
import { readFileSync } from 'fs';

/** 注册响应不回显验证码字段（captcha/captchaId 是请求参数，不是用户属性）。 */
describe('createUser response', () => {
  it('omit 列表包含 password、captcha、captchaId', () => {
    const src = readFileSync(require.resolve('../src/service/user/index.ts'), 'utf8');
    assert.ok(/omit\(entity, \['password', 'captcha', 'captchaId'\]\)/.test(src));
  });
});
