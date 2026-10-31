import * as assert from 'assert';
import { BillingStore, findSku, effectiveTier, toolCost, SKUS, phasePrice, currentPhase } from '../src/mcp/billing';
import { McpStore } from '../src/mcp/store';

/**
 * 计费 SQL 必须对着真 MySQL 测（扣点原子性、懒发放、订单幂等都在 SQL 里）。
 * CI（test.yml）有 MySQL 服务；本地没有库时整组跳过。
 * 每次跑建一个独立临时库，跑完删掉，不碰 fe-journey 业务表。
 */
describe('MCP 计费（真 MySQL）', function () {
  this.timeout(30000);
  let conn: any;
  let q: (sql: string, params?: any[]) => Promise<any>;
  const dbName = `mcp_billing_test_${Date.now()}`;

  before(async function () {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mysql = require('mysql2/promise');
      conn = await mysql.createConnection({
        host: process.env.MCP_TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
        user: process.env.MCP_TEST_DB_USER || process.env.DB_USER || 'root',
        password: process.env.MCP_TEST_DB_PASS ?? process.env.DB_PASS ?? '',
        connectTimeout: 3000,
        dateStrings: true,
      });
      await conn.query(`CREATE DATABASE \`${dbName}\``);
      await conn.query(`USE \`${dbName}\``);
    } catch {
      this.skip();
    }
    q = async (sql, params) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    };
  });

  after(async () => {
    if (conn) {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
      await conn.end().catch(() => {});
    }
  });

  it('开通送体验点且只送一次', async () => {
    const b = new BillingStore(q);
    const r1 = await b.activate('u1');
    const r2 = await b.activate('u1');
    assert.strictEqual(r1.created, true);
    assert.strictEqual(r2.created, false);
    assert.strictEqual((await b.getAccount('u1'))!.points, 100);
    assert.strictEqual(effectiveTier(await b.getAccount('u1')), 'free');
  });

  it('扣点原子：余额不足不扣、返回 null；退点恢复', async () => {
    const b = new BillingStore(q);
    await b.activate('u2');
    assert.strictEqual(await b.charge('u2', 60, 'x'), 40);
    assert.strictEqual(await b.charge('u2', 60, 'x'), null);
    assert.strictEqual((await b.getAccount('u2'))!.points, 40);
    await b.refund('u2', 60, 'x');
    assert.strictEqual((await b.getAccount('u2'))!.points, 100);
  });

  it('并发扣点不会扣成负数', async () => {
    const b = new BillingStore(q);
    await b.activate('u3');
    const results = await Promise.all(Array.from({ length: 8 }, () => b.charge('u3', 30, 'x')));
    assert.strictEqual(results.filter(r => r !== null).length, 3);
    assert.strictEqual((await b.getAccount('u3'))!.points, 10);
  });

  it('订单：复用未完成单 → 自报 → 确认发货 → 重复确认不重复发点', async () => {
    const b = new BillingStore(q);
    const sku = findSku('starter_month')!;
    const o1 = await b.createOrder('u4', sku, phasePrice(sku, 'half'));
    const o2 = await b.createOrder('u4', sku, phasePrice(sku, 'half'));
    assert.strictEqual(o2.order_no, o1.order_no);
    // 跨阶段调价后不复用旧价格的待付款单
    const o3 = await b.createOrder('u4', sku, sku.listCents);
    assert.notStrictEqual(o3.order_no, o1.order_no);
    assert.strictEqual(Number(o3.amount_cents), sku.listCents);
    assert.strictEqual(await b.reportPaid(o1.order_no, 'someone_else'), false);
    assert.strictEqual(await b.reportPaid(o1.order_no, 'u4'), true);
    assert.strictEqual(await b.fulfill(o1.order_no, 'admin'), 'ok');
    assert.strictEqual(await b.fulfill(o1.order_no, 'admin'), 'already');
    const a = (await b.getAccount('u4'))!;
    assert.strictEqual(a.points, 300);
    assert.strictEqual(effectiveTier(a), 'starter');
    assert.strictEqual(a.monthly_points, 300);
  });

  it('同档续费顺延到期日、不立刻加点；换档立刻生效并发首月点', async () => {
    const b = new BillingStore(q);
    await b.applyPlan('u5', findSku('starter_month')!, 'o1');
    const before = (await b.getAccount('u5'))!;
    await b.applyPlan('u5', findSku('starter_year')!, 'o2');
    const after = (await b.getAccount('u5'))!;
    assert.strictEqual(after.points, before.points);
    assert.ok(after.tier_expire_at! > before.tier_expire_at!);
    await b.applyPlan('u5', findSku('pro_month')!, 'o3');
    const pro = (await b.getAccount('u5'))!;
    assert.strictEqual(effectiveTier(pro), 'pro');
    assert.strictEqual(pro.points, before.points + 1200);
  });

  it('会员月度点懒发放：到期前每满一月补一次', async () => {
    const b = new BillingStore(q);
    await b.applyPlan('u6', findSku('pro_year')!, 'o');
    await q("UPDATE mcp_account SET next_grant_at = DATE_SUB(NOW(), INTERVAL 45 DAY) WHERE user_id = 'u6'");
    const a = (await b.getAccount('u6'))!;
    // 首月 1200 + 补发两次（-45 天、-15 天）
    assert.strictEqual(a.points, 1200 * 3);
    const again = (await b.getAccount('u6'))!;
    assert.strictEqual(again.points, 1200 * 3);
  });

  it('会员过期后按体验档处理，余额照常可用', async () => {
    const b = new BillingStore(q);
    await b.applyPlan('u7', findSku('starter_month')!, 'o');
    await q("UPDATE mcp_account SET tier_expire_at = DATE_SUB(NOW(), INTERVAL 1 DAY), next_grant_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE user_id = 'u7'");
    const a = (await b.getAccount('u7'))!;
    assert.strictEqual(effectiveTier(a), 'free');
    assert.strictEqual(a.points, 300); // 月卡：下次发放日 = 到期日，过期后不再补发
    assert.strictEqual(await b.charge('u7', 2, 'x'), 298);
  });

  it('加油包加点；驳回的订单不能再确认；看板统计已确认收入', async () => {
    const b = new BillingStore(q);
    const pack = findSku('pack_500')!;
    const o = await b.createOrder('u8', pack, phasePrice(pack, 'half'));
    await b.reportPaid(o.order_no, 'u8');
    assert.strictEqual(await b.fulfill(o.order_no, 'admin'), 'ok');
    assert.strictEqual((await b.getAccount('u8'))!.points, 500);
    const bad = await b.createOrder('u8', findSku('pack_100')!, 500);
    assert.strictEqual(await b.reject(bad.order_no, 'admin', '未收到款'), true);
    assert.strictEqual(await b.fulfill(bad.order_no, 'admin'), 'already');
    const s = await b.stats(30);
    assert.ok(s.revenue.windowCents >= phasePrice(pack, 'half'));
    assert.ok(s.users.total >= 1);
    // 失败退点要从热门工具的点数里扣掉（u2 扣 60 后退回 60）
    const x = s.topTools.find((t: any) => t.tool === 'x');
    assert.ok(Number(x.failed) >= 1);
    const charged = await q("SELECT SUM(-delta) n FROM mcp_points_ledger WHERE reason = 'call' AND ref = 'x'");
    assert.strictEqual(Number(x.points), Number(charged[0].n) - 60);
  });

  it('旧版 mcp_api_key 表自动补 user_id 列；用户只能吊销自己的 Key', async () => {
    await q(`CREATE TABLE mcp_api_key (
      id INT AUTO_INCREMENT PRIMARY KEY, key_hash CHAR(64) NOT NULL, key_prefix VARCHAR(16) NOT NULL,
      scope VARCHAR(16) NOT NULL DEFAULT 'all', owner VARCHAR(128) NOT NULL, note VARCHAR(255) NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active', daily_limit INT NOT NULL DEFAULT 2000,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME NULL,
      UNIQUE KEY uk_mcp_key_hash (key_hash))`);
    const s = new McpStore(q);
    const { key } = await s.create({ scope: 'all', owner: 'user:u9', userId: 'u9' });
    const row = await s.findActive(key);
    assert.strictEqual(row!.user_id, 'u9');
    assert.strictEqual(await s.countActiveByUser('u9'), 1);
    assert.strictEqual(await s.revokeOwn(Number(row!.id), 'intruder'), false);
    assert.strictEqual(await s.revokeOwn(Number(row!.id), 'u9'), true);
    assert.strictEqual(await s.findActive(key), null);
  });

  it('用量看板只算用户自助 Key：活跃用户、回访、失败、按单价折算点数', async () => {
    const s = new McpStore(q);
    const b = new BillingStore(q);
    await b.activate('ua');
    const { key: ka } = await s.create({ scope: 'all', owner: 'user:ua', userId: 'ua' });
    const { key: kadmin } = await s.create({ scope: 'all', owner: '测试' });
    const ra = (await s.findActive(ka))!;
    const radm = (await s.findActive(kadmin))!;
    for (const [tool, ok] of [['knowledge_get', true], ['knowledge_get', true], ['knowledge_get', false]] as const)
      await s.log({ keyId: Number(ra.id), product: 'agent', tool, ok, latencyMs: 5 });
    await s.log({ keyId: Number(radm.id), product: 'agent', tool: 'knowledge_get', ok: true, latencyMs: 5 });
    // 昨天也来过一次＝回访
    await q("INSERT INTO mcp_call_log (key_id, product, tool, ok, latency_ms, created_at) VALUES (?, 'agent', 'knowledge_search', 1, 5, DATE_SUB(NOW(), INTERVAL 1 DAY))", [ra.id]);
    const u = await b.usageStats(30);
    const kg = u.tools.find((t: any) => t.tool === 'knowledge_get');
    assert.deepStrictEqual([kg.calls, kg.failed, kg.users, kg.wouldBePoints], [3, 1, 1, 4]);
    assert.ok(u.activeUsers >= 1 && u.repeatUsers >= 1);
    assert.ok(u.topUsers.some((x: any) => x.userId === 'ua' && x.activeDays === 2));
    assert.ok(!u.topUsers.some((x: any) => !x.userId));
    assert.ok(u.signups.length >= 1);
  });
});

describe('MCP 计价表', () => {
  it('三阶段价格：免费 0、半价五折、正式价＝原价；阶段按北京时间切换', () => {
    for (const s of SKUS) {
      assert.strictEqual(phasePrice(s, 'free'), 0);
      assert.strictEqual(phasePrice(s, 'half'), Math.round(s.listCents / 2));
      assert.strictEqual(phasePrice(s, 'full'), s.listCents);
    }
    assert.strictEqual(currentPhase(new Date('2026-11-30T23:59:59+08:00')).id, 'free');
    assert.strictEqual(currentPhase(new Date('2026-12-01T00:00:00+08:00')).id, 'half');
    assert.strictEqual(currentPhase(new Date('2027-06-01T00:00:00+08:00')).next, null);
    assert.strictEqual(toolCost('methodology_get'), 0);
    assert.strictEqual(toolCost('unknown_tool'), 1);
  });
});
