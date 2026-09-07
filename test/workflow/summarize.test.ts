import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * FC 日志聚合白名单行为测试（2026-09-07 增量审查 P2-10）：
 * 旧实现用 `\b[A-Za-z]+(Error|Exception)\b` 从任意原文提取"异常名"，token / 用户名字段里
 * 恰好以 Error/Exception 结尾的字符串会被原样回显到公开日志。修复＝固定异常类型枚举，
 * 未知值只计入 Other。喂合成输入（下列字符串均为虚构）断言不回显。
 */
const SUMMARY = join(__dirname, '..', '..', 'scripts', 'summarize-logs.sh');
const summarize = (input: string): string =>
  execFileSync('bash', [SUMMARY], { input, encoding: 'utf8' });

describe('FC 日志聚合：异常名固定枚举', () => {
  it('普通消息 / token / 用户名字段里匹配正则的文本不会被回显', () => {
    const out = summarize(
      '2026-09-07 12:00:00 INFO token=HighlyPrivateSecretError userId=AliceSmithException\n' +
      '2026-09-07 12:00:01 ERROR msg=CustomerNameError happened\n');
    assert.ok(!out.includes('HighlyPrivateSecretError'), 'token 字段被当异常名回显');
    assert.ok(!out.includes('AliceSmithException'), '用户名字段被当异常名回显');
    assert.ok(!out.includes('CustomerNameError'), '自由文本被当异常名回显');
    assert.ok(/Other/.test(out), '未知异常名应只计入 Other');
  });

  it('白名单内的标准异常名照常计数', () => {
    const out = summarize(
      'ERROR TypeError: x is not a function\nERROR TypeError: y\nERROR RangeError: z\n');
    assert.ok(/2\s+TypeError/.test(out), '白名单异常应计数');
    assert.ok(/1\s+RangeError/.test(out));
  });
});
