import * as assert from 'assert';
import { BillingStore, REFERRAL_REWARD, TRIAL_POINTS } from '../src/mcp/billing';
import { ReferralStore, maskUser } from '../src/mcp/referral';

/**
 * 邀请拉新规则对着真 MySQL 测（计奖、幂等、同 IP 冻结、月上限都在 SQL 里）。
 * 与 mcp.billing.test.ts 同一套：CI 有 MySQL 服务；本地没有库整组跳过。
 */
describe('邀请拉新（真 MySQL）', function () {
  this.timeout(30000);
  let conn: any;
  let q: (sql: string, params?: any[]) => Promise<any>;
  const dbName = `mcp_referral_test_${Date.now()}`;

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
      // 只建邀请码查找需要的两列
      await conn.query(
        'CREATE TABLE `user` (id INT AUTO_INCREMENT PRIMARY KEY, phoneNumber VARCHAR(32) NOT NULL, inviteCode VARCHAR(32) NOT NULL DEFAULT "") DEFAULT CHARSET=utf8mb4'
      );
      await conn.query('INSERT INTO `user` (phoneNumber, inviteCode) VALUES (?, ?), (?, ?)', [
        'inviter1',
        'CODE1',
        'inviter2',
        'CODE2',
      ]);
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

  it('带码注册：双方得点、受邀者顺手开通；重复不再发', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    const out = await r.recordSignup({ inviteeId: 'new1', code: 'CODE1', ip: '1.1.1.1' });
    assert.strictEqual(out.status, 'rewarded');
    assert.strictEqual((await b.getAccount('new1'))!.points, TRIAL_POINTS + REFERRAL_REWARD.invitee);
    assert.strictEqual((await b.getAccount('inviter1'))!.points, REFERRAL_REWARD.inviter);
    const again = await r.recordSignup({ inviteeId: 'new1', code: 'CODE1', ip: '1.1.1.1' });
    assert.strictEqual(again.status, 'ignored');
    assert.strictEqual((await b.getAccount('inviter1'))!.points, REFERRAL_REWARD.inviter);
  });

  it('无效码 / 自邀 / 无码：忽略且不写关系', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    assert.strictEqual((await r.recordSignup({ inviteeId: 'x1', code: 'NOPE' })).status, 'ignored');
    assert.strictEqual((await r.recordSignup({ inviteeId: 'inviter1', code: 'CODE1' })).status, 'ignored');
    assert.strictEqual((await r.recordSignup({ inviteeId: 'x2', code: '' })).status, 'ignored');
    const rows = await q('SELECT COUNT(*) AS n FROM referral WHERE invitee_id IN (?, ?, ?)', ['x1', 'inviter1', 'x2']);
    assert.strictEqual(Number(rows[0].n), 0);
  });

  it('同一邀请人 24h 内同 IP 第二个注册：记关系但冻结奖励', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    const before = (await b.getAccount('inviter1'))!.points;
    const out = await r.recordSignup({ inviteeId: 'new2', code: 'CODE1', ip: '1.1.1.1' });
    assert.deepStrictEqual(out, { status: 'held', inviter: 'inviter1', reason: 'same_ip' });
    assert.strictEqual((await b.getAccount('inviter1'))!.points, before);
    assert.strictEqual(await b.getAccount('new2'), null, '冻结时不替受邀者开户');
  });

  it('月上限：计奖满 N 个后新的注册只记关系', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    for (let i = 0; i < REFERRAL_REWARD.monthlyCap; i++) {
      const out = await r.recordSignup({ inviteeId: `cap${i}`, code: 'CODE2', ip: `10.0.0.${i}` });
      assert.strictEqual(out.status, 'rewarded', `第 ${i + 1} 个应计奖`);
    }
    const over = await r.recordSignup({ inviteeId: 'capX', code: 'CODE2', ip: '10.0.1.1' });
    assert.deepStrictEqual(over, { status: 'held', inviter: 'inviter2', reason: 'cap' });
    const s = await r.stats('inviter2');
    assert.strictEqual(s.invited, REFERRAL_REWARD.monthlyCap + 1);
    assert.strictEqual(s.rewarded, REFERRAL_REWARD.monthlyCap);
    assert.strictEqual(s.held, 1);
    assert.strictEqual(s.monthUsed, REFERRAL_REWARD.monthlyCap);
    assert.strictEqual(s.pointsEarned, REFERRAL_REWARD.monthlyCap * REFERRAL_REWARD.inviter);
    assert.strictEqual(s.code, 'CODE2');
  });

  it('受邀者开会员：邀请人加一次 memberBonus；冻结的关系同样计；再付不重复', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    const before = (await b.getAccount('inviter1'))!.points;
    const first = await r.onMemberPaid('new1');
    assert.deepStrictEqual(first, { inviter: 'inviter1', points: REFERRAL_REWARD.memberBonus });
    assert.strictEqual(await r.onMemberPaid('new1'), null);
    const held = await r.onMemberPaid('new2');
    assert.ok(held && held.points === REFERRAL_REWARD.memberBonus);
    assert.strictEqual(await r.onMemberPaid('stranger'), null);
    assert.strictEqual((await b.getAccount('inviter1'))!.points, before + 2 * REFERRAL_REWARD.memberBonus);
    const s = await r.stats('inviter1');
    assert.strictEqual(s.members, 2);
  });

  it('流水里的手机号脱敏', () => {
    assert.strictEqual(maskUser('13812345678'), '138****5678');
    assert.strictEqual(maskUser('abc'), 'ab****');
  });
});
