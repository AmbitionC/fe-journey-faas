import * as assert from 'assert';
import { BillingStore } from '../src/mcp/billing';
import { ReferralStore } from '../src/mcp/referral';
import { referralSummary } from '../src/service/growth/referralSummary';

/** 邀请裂变漏斗汇总：对着真 MySQL 测（与 mcp.referral.test.ts 同一套，本地没库整组跳过）。 */
describe('邀请裂变漏斗汇总（真 MySQL）', function () {
  this.timeout(30000);
  let conn: any;
  let q: (sql: string, params?: any[]) => Promise<any>;
  const dbName = `referral_summary_test_${Date.now()}`;

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
    await q(
      'CREATE TABLE `user` (id INT AUTO_INCREMENT PRIMARY KEY, phoneNumber VARCHAR(32) NOT NULL, inviteCode VARCHAR(32) NOT NULL DEFAULT "", nickName VARCHAR(64) NULL, createTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    );
    await q(`CREATE TABLE member_entitlement (id INT AUTO_INCREMENT PRIMARY KEY,
      createTime DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updateTime DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      userId VARCHAR(64) NOT NULL, source VARCHAR(24) NOT NULL, startAt DATETIME NOT NULL, expireAt DATETIME NOT NULL, meta JSON NULL)`);
    await q(`CREATE TABLE event_log (id INT AUTO_INCREMENT PRIMARY KEY, createTime DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      userId VARCHAR(64) NULL, channel VARCHAR(64) NULL, event VARCHAR(64) NOT NULL, props JSON NULL)`);
    await q(`CREATE TABLE mcp_event (id BIGINT AUTO_INCREMENT PRIMARY KEY, event VARCHAR(40) NOT NULL, source VARCHAR(8) NOT NULL DEFAULT 'server',
      user_id VARCHAR(64) NULL, props TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await q("INSERT INTO `user` (phoneNumber, inviteCode) VALUES ('13800000001', 'AAAA1111'), ('13900000002', 'BBBB2222')");
  });

  after(async () => {
    if (conn) {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
      await conn.end().catch(() => {});
    }
  });

  it('各步计数、入口拆分、冻结原因、权益成本、脱敏 Top 邀请人；内部账号排除', async () => {
    const r = new ReferralStore(q, new BillingStore(q));
    await r.recordSignup({ inviteeId: 'f1', code: 'AAAA1111', ip: '1.1.1.1', via: 'sms' });
    await r.recordSignup({ inviteeId: 'f2', code: 'AAAA1111', ip: '1.1.1.1', via: 'signup' }); // 同 IP 冻结
    await r.recordSignup({ inviteeId: 'f3', code: 'BBBB2222', ip: '2.2.2.2', via: 'bind' });
    await r.onMemberPaid('f1');
    const web = [
      ['13800000001', 'invite_card_view', '{}'],
      ['13800000001', 'invite_share', '{"via":"text"}'],
      ['13800000001', 'invite_share', '{"via":"qr"}'],
      ['guest:9.9.9.9', 'invite_landing', '{"code":"AAAA1111"}'],
      ['guest:9.9.9.9', 'invite_banner_view', '{}'],
      ['guest:9.9.9.9', 'invite_banner_click', '{}'],
      ['13900000002', 'invite_share', '{"via":"link"}'],
    ];
    for (const [u, e, p] of web) await q('INSERT INTO event_log (userId, event, props) VALUES (?, ?, ?)', [u, e, p]);
    await q(
      "INSERT INTO mcp_event (event, props) VALUES ('referral_signup', '{\"status\":\"ignored\",\"reason\":\"unknown_code\"}')"
    );

    const s: any = await referralSummary(q, 7, []);
    assert.deepStrictEqual(s.funnel.share, { count: 3, users: 2 });
    assert.deepStrictEqual(s.funnel.landing, { count: 1, users: 1 });
    assert.deepStrictEqual(s.funnel.bannerClick, { count: 1, users: 1 });
    assert.strictEqual(s.funnel.invited, 3);
    assert.strictEqual(s.funnel.rewarded, 2);
    assert.strictEqual(s.funnel.paidMembers, 1);
    assert.deepStrictEqual(s.invitedVia, { sms: 1, signup: 1, bind: 1 });
    assert.deepStrictEqual(s.shareVia, { text: 1, qr: 1, link: 1 });
    assert.deepStrictEqual(s.held, { sameIp: 1, cap: 0, other: 0 });
    assert.deepStrictEqual(s.rejected, { unknown_code: 1 });
    assert.strictEqual(s.activeInviters, 2);
    assert.ok(s.cost.inviteeDays > 0 && s.cost.inviterDays > 0 && s.cost.paidBonusDays > 0 && s.cost.points > 0);
    assert.strictEqual(s.topInviters[0].inviter, '138****0001');
    assert.ok(!JSON.stringify(s).includes('13800000001'), '不出完整号码');

    const ex: any = await referralSummary(q, 7, ['13800000001']);
    assert.strictEqual(ex.funnel.invited, 1, '内部账号的邀请不计');
    assert.deepStrictEqual(ex.funnel.share, { count: 1, users: 1 });
  });

  it('表不存在时对应项为 null，不伪造为零', async () => {
    const s: any = await referralSummary(async () => {
      throw new Error('no table');
    }, 7, []);
    assert.strictEqual(s.funnel.share, null);
    assert.strictEqual(s.funnel.invited, null);
    assert.strictEqual(s.topInviters, null);
  });
});
