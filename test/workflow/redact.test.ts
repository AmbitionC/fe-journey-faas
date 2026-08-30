import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * FC 日志脱敏行为测试（2026-08-30 二次验收 P1-2）：对 scripts/redact-logs.sh
 * 喂合成敏感日志、断言输出不含任何原始敏感片段——测的是真实执行行为，
 * 不是源码文本形态；fc-logs.yml 调同一脚本，规则不会漂。
 */
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'redact-logs.sh');
const SUMMARY = join(__dirname, '..', '..', 'scripts', 'summarize-logs.sh');

const redact = (input: string): string =>
  execFileSync('bash', [SCRIPT], { input, encoding: 'utf8' });

const summarize = (input: string): string =>
  execFileSync('bash', [SUMMARY], { input, encoding: 'utf8' });

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


  // ── 第三轮验收 P1-1 的四条反例：黑名单遮不住的残留 ──
  it('Cookie 串里每一对键值都被掩码（不只第一对）', () => {
    const out = redact('Cookie: session=abc123; auth=secret456; jwt=eyJ.secret');
    assert.ok(!out.includes('abc123'), 'Cookie 首对未脱敏');
    assert.ok(!out.includes('secret456'), 'Cookie 第二对残留');
    assert.ok(!out.includes('eyJ.secret'), 'Cookie 第三对残留');
  });

  it('Authorization 值一直遮到行尾（含冒号等字符集外字符）', () => {
    const out = redact('Authorization: Bearer abc:TAIL_SECRET rows=3');
    assert.ok(!out.includes('TAIL_SECRET'), '授权头尾段残留');
  });

  it('带引号且含空格的 token 值整体被掩码', () => {
    const out = redact('token: "SPACE SECRET" done');
    assert.ok(!out.includes('SPACE SECRET'), '引号内 token 残留');
    assert.ok(!out.includes('SECRET'), 'token 后半段残留');
  });

  it('用户标识与长数字串（卡号等）被掩码', () => {
    const out = redact('userId=998877 idcard=310101199001011234 card 6222020000000000000');
    assert.ok(!out.includes('998877'), 'userId 残留');
    assert.ok(!out.includes('310101199001011234'), '身份证号残留');
    assert.ok(!out.includes('6222020000000000000'), '卡号残留');
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

  // ── 公开 job 的默认输出：结构化聚合，零自由文本（第三轮验收 P1-1）──
  it('聚合输出不含任何原始日志文本片段', () => {
    const raw = [
      '2026-08-30T10:00:00 INFO login user=alice@example.com Cookie: s=abc123 status=200',
      '2026-08-30T10:05:00 ERROR ETIMEDOUT db=mysql://root:S3cret@10.0.0.1/invest',
      '2026-08-30T10:06:00 ERROR TypeError: cannot read prop of undefined phone=13812345678',
    ].join('\n');
    const out = summarize(raw);
    for (const secret of ['alice@example.com', 'abc123', 'S3cret', '13812345678',
                          'cannot read prop', '10.0.0.1']) {
      assert.ok(!out.includes(secret), `聚合输出泄露片段: ${secret}`);
    }
    assert.ok(/行数/.test(out) && /3/.test(out), '应给出行数');
    assert.ok(out.includes('ETIMEDOUT'), '错误关键词计数应保留关键词名');
    assert.ok(out.includes('TypeError'), '异常类名白名单应保留');
    assert.ok(out.includes('200') && out.includes('ERROR'), '状态码/级别分布应保留');
  });

  it('fc-logs.yml 默认走聚合、原文须显式开关', () => {
    const yml = readFileSync(
      join(__dirname, '..', '..', '.github', 'workflows', 'fc-logs.yml'), 'utf8');
    assert.ok(yml.includes('scripts/summarize-logs.sh'), '未接入聚合脚本');
    assert.ok(/include_text/.test(yml), '缺 include_text 开关');
    assert.ok(/TEXT_IN.*=.*"true"|\[ "\$TEXT_IN" = "true" \]/.test(yml), '原文未被开关保护');
  });
});
