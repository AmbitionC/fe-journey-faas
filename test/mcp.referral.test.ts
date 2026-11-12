import * as assert from 'assert';
import { BillingStore, REFERRAL_DAYS, REFERRAL_REWARD, TRIAL_POINTS } from '../src/mcp/billing';
import { ReferralStore, maskNick, maskUser, programView, sanitizeCode } from '../src/mcp/referral';

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
      // 只建邀请需要的几列
      await conn.query(
        'CREATE TABLE `user` (id INT AUTO_INCREMENT PRIMARY KEY, phoneNumber VARCHAR(32) NOT NULL, inviteCode VARCHAR(32) NOT NULL DEFAULT "", nickName VARCHAR(64) NULL, createTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) DEFAULT CHARSET=utf8mb4'
      );
      await conn.query('INSERT INTO `user` (phoneNumber, inviteCode, nickName) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)', [
        'inviter1',
        'CODE1',
        '小明同学',
        'inviter2',
        'CODE2',
        null,
        'inviter3',
        'CODE3',
        null,
      ]);
      // 与 TypeORM 实体 MemberEntitlementEntity 同结构（线上表由早期 synchronize 建成）
      await conn.query(`CREATE TABLE member_entitlement (
        id INT AUTO_INCREMENT PRIMARY KEY,
        createTime DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updateTime DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        userId VARCHAR(64) NOT NULL, source VARCHAR(24) NOT NULL,
        startAt DATETIME NOT NULL, expireAt DATETIME NOT NULL, meta JSON NULL
      ) DEFAULT CHARSET=utf8mb4`);
    } catch {
      this.skip();
    }
    q = async (sql, params) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    };
  });

  /** 某人 member_entitlement 里 referral 来源的总天数（按 expireAt 顺延，取最晚到期距今的天数） */
  const daysLeft = async (uid: string): Promise<number> => {
    const rows = await q('SELECT MAX(expireAt) AS e FROM member_entitlement WHERE userId = ?', [uid]);
    if (!rows[0].e) return 0;
    return Math.round((new Date(rows[0].e).getTime() - Date.now()) / 86400000);
  };

  after(async () => {
    if (conn) {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
      await conn.end().catch(() => {});
    }
  });

  it('老账号没有邀请码：查成绩时补发一个，之后不变，且能被用来邀请', async () => {
    await q('INSERT INTO `user` (phoneNumber, inviteCode, nickName) VALUES (?, ?, ?)', ['nocode', '', null]);
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    const first = (await r.stats('nocode')).code;
    assert.ok(first && /^[0-9a-f]{8}$/.test(first), `补发的码：${first}`);
    assert.strictEqual((await r.stats('nocode')).code, first);
    const rows = await q('SELECT inviteCode FROM `user` WHERE phoneNumber = ?', ['nocode']);
    assert.strictEqual(rows[0].inviteCode, first);
    // 不存在的用户不凭空建码
    assert.strictEqual((await r.stats('ghost')).code, null);
  });

  it('带码注册：双方得点 + 会员天数、受邀者顺手开通；重复不再发', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    const out = await r.recordSignup({ inviteeId: 'new1', code: 'CODE1', ip: '1.1.1.1' });
    assert.strictEqual(out.status, 'rewarded');
    assert.ok(out.status === 'rewarded' && out.product === 'agent');
    assert.ok(out.status === 'rewarded' && out.inviteeDays === REFERRAL_DAYS.invitee);
    assert.ok(out.status === 'rewarded' && out.inviterDays === REFERRAL_DAYS.inviter);
    assert.strictEqual(await daysLeft('new1'), REFERRAL_DAYS.invitee);
    assert.strictEqual(await daysLeft('inviter1'), REFERRAL_DAYS.inviter);
    assert.strictEqual((await b.getAccount('new1'))!.points, TRIAL_POINTS + REFERRAL_REWARD.invitee);
    assert.strictEqual((await b.getAccount('inviter1'))!.points, REFERRAL_REWARD.inviter);
    const again = await r.recordSignup({ inviteeId: 'new1', code: 'CODE1', ip: '1.1.1.1' });
    assert.strictEqual(again.status, 'ignored');
    assert.strictEqual((await b.getAccount('inviter1'))!.points, REFERRAL_REWARD.inviter);
    assert.strictEqual(await daysLeft('inviter1'), REFERRAL_DAYS.inviter, '重复不再送天数');
  });

  it('互邀不认：A 邀了 new1，new1 的码不能再反邀 A', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    await q('INSERT INTO `user` (phoneNumber, inviteCode) VALUES (?, ?)', ['new1', 'NEW1CODE']);
    const out = await r.recordSignup({ inviteeId: 'inviter1', code: 'NEW1CODE' });
    assert.deepStrictEqual(out, { status: 'ignored', reason: 'circular' });
  });

  it('注册后补填：7 天内可以，超过窗口不行', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    await q('INSERT INTO `user` (phoneNumber, inviteCode, createTime) VALUES (?, ?, NOW()), (?, ?, NOW() - INTERVAL 8 DAY)', [
      'fresh',
      'FRESHX',
      'stale',
      'STALEX',
    ]);
    assert.strictEqual((await r.stats('fresh')).canBind, true);
    assert.strictEqual((await r.stats('stale')).canBind, false);
    const late = await r.recordSignup({ inviteeId: 'stale', code: 'CODE3', requireWindow: true });
    assert.deepStrictEqual(late, { status: 'ignored', reason: 'too_late' });
    const ok = await r.recordSignup({ inviteeId: 'fresh', code: 'CODE3', ip: '9.9.9.9', requireWindow: true, product: 'agent' });
    const viaRow = await q("SELECT via FROM referral WHERE invitee_id = 'fresh'");
    assert.strictEqual(viaRow[0].via, 'bind', '补填入口记为 bind');
    assert.strictEqual(ok.status, 'rewarded');
    const s = await r.stats('fresh');
    assert.strictEqual(s.canBind, false, '绑过之后不能再补填');
    assert.strictEqual(s.invitedBy, maskUser('inviter3'));
  });

  it('按产品发奖：Invest 只送点不送天数，栗栗学英语只记关系', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    const inv = await r.recordSignup({ inviteeId: 'inv1', code: 'CODE3', ip: '8.8.8.1', product: 'invest' });
    assert.ok(inv.status === 'rewarded' && inv.product === 'invest' && inv.inviteeDays === 0 && inv.inviterDays === 0);
    assert.strictEqual(await daysLeft('inv1'), 0);
    assert.strictEqual((await b.getAccount('inv1'))!.points, TRIAL_POINTS + REFERRAL_REWARD.invitee);
    const kid = await r.recordSignup({ inviteeId: 'kid1', code: 'CODE3', ip: '8.8.8.2', product: 'kids' });
    assert.ok(kid.status === 'rewarded' && kid.product === 'kids' && kid.inviteePoints === 0);
    assert.strictEqual(await b.getAccount('kid1'), null, '没有点数奖励时不替受邀者开户');
    const rows = await q('SELECT product FROM referral WHERE invitee_id IN (?, ?) ORDER BY invitee_id', ['inv1', 'kid1']);
    assert.deepStrictEqual(rows.map((x: any) => x.product), ['invest', 'kids']);
    // 未知产品按 agent
    assert.strictEqual(programView('nope').product, 'agent');
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
    assert.deepStrictEqual(out, { status: 'held', inviter: 'inviter1', product: 'agent', reason: 'same_ip' });
    assert.strictEqual(await daysLeft('new2'), 0, '冻结时不送天数');
    assert.strictEqual((await b.getAccount('inviter1'))!.points, before);
    assert.strictEqual(await b.getAccount('new2'), null, '冻结时不替受邀者开户');
  });

  it('月上限：计奖满 N 个后新的注册只记关系；邀请人注册天数按月封顶', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    for (let i = 0; i < REFERRAL_REWARD.monthlyCap; i++) {
      const out = await r.recordSignup({ inviteeId: `cap${i}`, code: 'CODE2', ip: `10.0.0.${i}` });
      assert.strictEqual(out.status, 'rewarded', `第 ${i + 1} 个应计奖`);
    }
    const over = await r.recordSignup({ inviteeId: 'capX', code: 'CODE2', ip: '10.0.1.1' });
    assert.deepStrictEqual(over, { status: 'held', inviter: 'inviter2', product: 'agent', reason: 'cap' });
    const s = await r.stats('inviter2');
    assert.strictEqual(s.invited, REFERRAL_REWARD.monthlyCap + 1);
    assert.strictEqual(s.rewarded, REFERRAL_REWARD.monthlyCap);
    assert.strictEqual(s.held, 1);
    assert.strictEqual(s.monthUsed, REFERRAL_REWARD.monthlyCap);
    assert.strictEqual(s.pointsEarned, REFERRAL_REWARD.monthlyCap * REFERRAL_REWARD.inviter);
    assert.strictEqual(s.code, 'CODE2');
    const capDays = Math.min(REFERRAL_DAYS.monthlyCapDays, REFERRAL_DAYS.lifetimeCapDays, REFERRAL_REWARD.monthlyCap * REFERRAL_DAYS.inviter);
    assert.strictEqual(s.monthDays, capDays, '邀请人注册天数不超过月上限');
    assert.strictEqual(s.daysEarned, capDays);
    assert.strictEqual(await daysLeft('inviter2'), capDays);
    // 被邀请人不受邀请人上限影响
    assert.strictEqual(await daysLeft(`cap${REFERRAL_REWARD.monthlyCap - 1}`), REFERRAL_DAYS.invitee);
  });

  it('终身上限：历史已拿满的邀请人，新注册不再送天数（点数照发）', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    await q('INSERT INTO `user` (phoneNumber, inviteCode) VALUES (?, ?)', ['vet', 'VETCODE']);
    await q(
      "INSERT INTO referral (invitee_id, inviter_id, code, status, inviter_days, signup_reward_at, created_at) VALUES (?, 'vet', 'VETCODE', 'rewarded', ?, NOW() - INTERVAL 60 DAY, NOW() - INTERVAL 60 DAY)",
      ['old-friend', REFERRAL_DAYS.lifetimeCapDays]
    );
    const out = await r.recordSignup({ inviteeId: 'vetfriend', code: 'VETCODE', ip: '7.7.7.7' });
    assert.ok(out.status === 'rewarded' && out.inviterDays === 0 && out.inviteeDays === REFERRAL_DAYS.invitee);
    assert.strictEqual((await b.getAccount('vet'))!.points, REFERRAL_REWARD.inviter);
  });

  it('受邀者开会员：邀请人加一次 memberBonus 点 + 天数（不计上限）；冻结的关系同样计；再付不重复', async () => {
    const b = new BillingStore(q);
    const r = new ReferralStore(q, b);
    const before = (await b.getAccount('inviter1'))!.points;
    const daysBefore = await daysLeft('inviter1');
    const first = await r.onMemberPaid('new1');
    assert.deepStrictEqual(first, { inviter: 'inviter1', points: REFERRAL_REWARD.memberBonus, days: REFERRAL_DAYS.memberBonus });
    assert.strictEqual(await daysLeft('inviter1'), daysBefore + REFERRAL_DAYS.memberBonus, '天数从当前到期日顺延');
    assert.strictEqual(await r.onMemberPaid('new1'), null);
    const held = await r.onMemberPaid('new2');
    assert.ok(held && held.points === REFERRAL_REWARD.memberBonus);
    assert.strictEqual(await r.onMemberPaid('stranger'), null);
    assert.strictEqual((await b.getAccount('inviter1'))!.points, before + 2 * REFERRAL_REWARD.memberBonus);
    const s = await r.stats('inviter1');
    assert.strictEqual(s.members, 2);
    assert.strictEqual(s.daysEarned, REFERRAL_DAYS.inviter + 2 * REFERRAL_DAYS.memberBonus);
  });

  it('落地页查码：有效码返回脱敏昵称，无效码 / 非法码不报错', async () => {
    const r = new ReferralStore(q, new BillingStore(q));
    assert.deepStrictEqual(await r.lookup('CODE1'), { valid: true, inviterNick: '小***' });
    assert.deepStrictEqual(await r.lookup('CODE2'), { valid: true, inviterNick: null });
    assert.deepStrictEqual(await r.lookup('NOPE00'), { valid: false, inviterNick: null });
    assert.deepStrictEqual(await r.lookup("x' OR 1=1"), { valid: false, inviterNick: null });
  });

  it('线上旧表（11/02 版）自动补列，旧关系按 agent、0 天', async () => {
    await q('RENAME TABLE referral TO referral_new_backup');
    await q(`CREATE TABLE referral (
      invitee_id VARCHAR(64) NOT NULL PRIMARY KEY, inviter_id VARCHAR(64) NOT NULL, code VARCHAR(32) NOT NULL,
      ip VARCHAR(64) NULL, status VARCHAR(16) NOT NULL DEFAULT 'rewarded', signup_reward_at DATETIME NULL,
      member_reward_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await q("INSERT INTO referral (invitee_id, inviter_id, code) VALUES ('legacy', 'inviter1', 'CODE1')");
    try {
      const r = new ReferralStore(q, new BillingStore(q));
      const s = await r.stats('inviter1');
      assert.strictEqual(s.invited, 1);
      assert.strictEqual(s.daysEarned, 0);
      const rows = await q("SELECT product, inviter_days FROM referral WHERE invitee_id = 'legacy'");
      assert.deepStrictEqual([rows[0].product, Number(rows[0].inviter_days)], ['agent', 0]);
    } finally {
      await q('DROP TABLE referral');
      await q('RENAME TABLE referral_new_backup TO referral');
    }
  });

  it('流水里的手机号脱敏', () => {
    assert.strictEqual(maskUser('13812345678'), '138****5678');
    assert.strictEqual(maskUser('abc'), 'ab****');
    assert.strictEqual(maskNick('张'), '张');
    assert.strictEqual(maskNick('张三'), '张*');
    assert.strictEqual(maskNick(''), '');
    assert.strictEqual(sanitizeCode(' ab12cd34 '), 'ab12cd34');
    assert.strictEqual(sanitizeCode('a b'), '');
  });
});
