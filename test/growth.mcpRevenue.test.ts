import * as assert from 'assert';
import { GrowthService } from '../src/service/growth';

/** 个人看板「副业经营」：会员 / 加油包收款计入，测试单与内部账号排除，今日按库时钟。 */
describe('副业经营计入会员 / 加油包收款', () => {
  function svc(handler: (sql: string, params: any[]) => any[]) {
    const s = new GrowthService();
    const calls: Array<{ sql: string; params: any[] }> = [];
    s.internalUserIds = ['19900001101'];
    (s as any).orderModel = {
      manager: {
        query: async (sql: string, params: any[]) => {
          calls.push({ sql, params });
          return handler(sql, params);
        },
      },
    };
    return { s, calls };
  }

  it('按 SKU 分会员 / 加油包汇总，SQL 排除 pay_test、管理员与内部账号', async () => {
    const { s, calls } = svc(sql =>
      /GROUP BY m.sku/.test(sql)
        ? [
            { sku: 'member_month', n: 2, cents: 2900 },
            { sku: 'member_year', n: 1, cents: 23900 },
            { sku: 'pack_100', n: 1, cents: 500 },
          ]
        : []
    );
    const r = await (s as any).mcpPaid(new Date('2026-11-01'));
    assert.deepStrictEqual(r.plan, { count: 3, amount: 268 });
    assert.deepStrictEqual(r.pack, { count: 1, amount: 5 });
    assert.match(calls[0].sql, /m\.sku <> 'pay_test'/);
    assert.match(calls[0].sql, /u\.role <> 'admin'/);
    assert.ok(calls[0].params.includes('19900001101'));
  });

  it('关联 user 表时 id 与手机号都认——mcp_order.user_id 存的是登录态里的手机号', async () => {
    // 只写 u.id = m.user_id 时一行都关联不上，管理员 / 内部账号排除等于没做（2026-11-08 复盘）
    const { s, calls } = svc(() => []);
    await (s as any).mcpPaid(new Date('2026-11-01'));
    await s.recentPayments(5);
    const joins = calls.filter(c => /FROM mcp_order m LEFT JOIN/.test(c.sql));
    assert.ok(joins.length >= 2);
    for (const c of joins) assert.match(c.sql, /u\.id = m\.user_id OR u\.phoneNumber = m\.user_id/);
  });

  it('收款流水带今日合计，今日用库的 CURDATE()', async () => {
    const { s, calls } = svc(sql =>
      /ORDER BY m.paid_at/.test(sql)
        ? [{ order_no: 'MJ1', sku: 'member_month', amount_cents: 1450, paid_at: '2026-11-03 10:00:00', handled_by: 'alipay:1' }]
        : [{ sku: 'member_month', n: 1, cents: 1450 }]
    );
    const r = await s.recentPayments(5);
    assert.deepStrictEqual(r.today, { count: 1, amount: 14.5 });
    assert.strictEqual(r.recent[0].via, 'alipay');
    assert.strictEqual(r.recent[0].amount, 14.5);
    assert.ok(calls.some(c => /CURDATE\(\)/.test(c.sql)));
  });
});
