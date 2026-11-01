import * as assert from 'assert';
import { skillSummary } from '../src/service/growth/skillSummary';

/**
 * Skill / MCP 经营汇总（2026-11-01）：复盘导出免登录，这组用例钉住三条：
 * 内部账号一定被排除、1 分钱测试单不算钱、查不到就是 null 而不是 0。
 */
describe('skillSummary 开发者服务汇总', () => {
  it('每条查询都排除内部账号，付款只认 paid 且排除 pay_test', async () => {
    const seen: { sql: string; params: any[] }[] = [];
    const q = async (sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/status = 'paid'/.test(sql)) return [{ orders: 2, users: 1, cents: 5800 }];
      return [{ n: 3, visitors: 9, installIntent: 4, users: 2, calls: 17, orders: 3, cents: 8700 }];
    };
    const out = await skillSummary(q, 7, ['13800000001']);
    assert.strictEqual(seen.length, 8);
    for (const { sql, params } of seen) {
      assert.ok(/NOT IN \(\?\)/.test(sql), sql);
      assert.ok(params.includes('13800000001'), sql);
    }
    for (const { sql } of seen.filter((s) => /FROM mcp_order/.test(s.sql))) {
      assert.ok(/sku <> 'pay_test'/.test(sql), sql);
    }
    assert.deepStrictEqual(out.paid, { orders: 2, users: 1, yuan: 58 });
    assert.strictEqual(out.calls, 17);
    assert.deepStrictEqual(out.page, { visitors: 9, installIntent: 4 });
  });

  it('某张表查不到（还没建表、超时）时那一项是 null，不伪造为零', async () => {
    const q = async (sql: string) => {
      if (/FROM mcp_call_log/.test(sql)) throw new Error("Table 'mcp_call_log' doesn't exist");
      return [{ n: 1 }];
    };
    const out = await skillSummary(q, 7, []);
    assert.strictEqual(out.calledUsers, null);
    assert.strictEqual(out.calls, null);
    assert.strictEqual(out.activated, 1);
  });

  it('没有内部账号时不拼 NOT IN，输出里没有任何号码', async () => {
    const seen: string[] = [];
    const q = async (sql: string) => {
      seen.push(sql);
      return [{}];
    };
    const out = await skillSummary(q, 30, []);
    assert.ok(seen.every((s) => !/NOT IN/.test(s)));
    assert.ok(!/\d{7,}/.test(JSON.stringify(out)));
  });
});
