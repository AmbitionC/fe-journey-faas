import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * FC 日志脱敏行为测试（2026-08-30 二次验收 P1-2）：对 scripts/redact-logs.sh
 * 喂合成敏感日志、断言输出不含任何原始敏感片段——测的是真实执行行为，
 * 不是源码文本形态；fc-logs.yml 调同一脚本，规则不会漂。
 */
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'redact-logs.sh');

const redact = (input: string): string =>
  execFileSync('bash', [SCRIPT], { input, encoding: 'utf8' });

describe('FC 日志脱敏白名单', () => {
  it('同一行内邮箱/授权头/连接串/手机号全部被掩码', () => {
    const line =
      'user=alice@example.com Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig ' +
      'db=mysql://root:S3cret@10.0.0.1:3306/invest phone=13812345678';
    const out = redact(line);
    assert.ok(!out.includes('alice@example.com'), '邮箱未脱敏');
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), 'Bearer token 未脱敏');
    assert.ok(!out.includes('S3cret'), '连接串口令未脱敏');
    assert.ok(!out.includes('13812345678'), '手机号未脱敏');
  });

  it('Cookie 与 api_key/password 键值对被掩码', () => {
    const out = redact(
      'Cookie: session=abc123def; theme=dark api_key=sk-live-42 password: hunter2');
    assert.ok(!out.includes('abc123def'), 'Cookie 值未脱敏');
    assert.ok(!out.includes('sk-live-42'), 'api_key 未脱敏');
    assert.ok(!out.includes('hunter2'), 'password 未脱敏');
  });

  it('普通业务日志不被破坏', () => {
    const line = '2026-08-30 job daily_update_plan finished rows=42 code=000300.SH';
    assert.strictEqual(redact(line).trim(), line);
  });

  it('fc-logs.yml 调用的是本脚本而非内联规则', () => {
    const fs = require('fs');
    const yml = fs.readFileSync(
      join(__dirname, '..', '..', '.github', 'workflows', 'fc-logs.yml'), 'utf8');
    assert.ok(yml.includes('scripts/redact-logs.sh'), 'workflow 未使用共享脱敏脚本');
    assert.ok(!/sed -E 's\/1\[3-9\]/.test(yml), 'workflow 不得内联复制脱敏规则');
  });
});
