import * as assert from 'assert';
import * as crypto from 'crypto';
import { ProjectHTTPService } from '../src/function/project';
import { signTrialTicket, trialDay, trialQuotaKey, trialTokenKey, TRIAL_PROJECTS } from '../src/service/project/trial';

function controller(opts: { userId?: string; member?: boolean } = {}) {
  const counts = new Map<string, number>();
  const c = new ProjectHTTPService();
  const userId = opts.userId === undefined ? 'u1' : opts.userId;
  c.ctx = { userInfo: userId ? { userId, role: 'user' } : undefined } as any;
  c.redisService = {
    incr: async (k: string) => { counts.set(k, (counts.get(k) || 0) + 1); return counts.get(k); },
    expire: async () => 1,
    get: async (k: string) => (counts.has(k) ? String(counts.get(k)) : null),
    set: async () => 'OK',
  } as any;
  c.eventLogModel = { save: async (e: any) => e } as any;
  c.entitlementService = { check: async () => ({ allowed: !!opts.member }) } as any;
  c.now = () => new Date('2026-11-18T23:30:00+08:00');
  return { c, counts };
}

describe('项目实战在线试用票据', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PROJECT_TRIAL_URL = 'https://trial.fixture.invalid/';
    process.env.PROJECT_TRIAL_TICKET_SECRET = 's3cret';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('票据格式与试用函数的验签一致：base64url(JSON).hmac', () => {
    const t = signTrialTicket({ jti: 'a', exp: 1 }, 's3cret');
    const [body, mac] = t.split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(body, 'base64url').toString()), { jti: 'a', exp: 1 });
    assert.strictEqual(mac, crypto.createHmac('sha256', 's3cret').update(body).digest('hex'));
  });

  it('按北京时间分日', () => {
    assert.strictEqual(trialDay(new Date('2026-11-18T23:30:00+08:00')), '2026-11-18');
    assert.strictEqual(trialDay(new Date('2026-11-18T16:30:00Z')), '2026-11-19');
    assert.strictEqual(trialQuotaKey('u1', new Date('2026-11-18T00:00:00+08:00'), 'general-agent'), 'project:trial:2026-11-18:u1:general-agent');
  });

  it('会员拿到票据和试用地址，返回剩余次数', async () => {
    const { c } = controller({ member: true });
    const r = await c.trialTicket({ projectId: 'general-agent' });
    assert.strictEqual(r.data.url, 'https://trial.fixture.invalid/run');
    assert.strictEqual(r.data.remaining, 9);
    const payload = JSON.parse(Buffer.from(r.data.ticket.split('.')[0], 'base64url').toString());
    assert.strictEqual(payload.scenario, 'store');
    assert.strictEqual(payload.exp, Math.floor(new Date('2026-11-18T23:30:00+08:00').getTime() / 1000) + 120);
  });

  it('评测与自进化项目有两个场景，默认第一个', async () => {
    const r = await controller({ member: true }).c.trialTicket({ projectId: 'eval-evolve' });
    const payload = JSON.parse(Buffer.from(r.data.ticket.split('.')[0], 'base64url').toString());
    assert.strictEqual(payload.scenario, 'evolve-prompt');
    assert.strictEqual(payload.project, 'eval-evolve');
    const r2 = await controller({ member: true }).c.trialTicket({ projectId: 'eval-evolve', scenario: 'evolve-config' });
    assert.strictEqual(r2.data.scenario, 'evolve-config');
    await assert.rejects(controller({ member: true }).c.trialTicket({ projectId: 'eval-evolve', scenario: 'shop' }), /场景/);
  });

  it('电商营销增长助手只有一个场景', async () => {
    const r = await controller({ member: true }).c.trialTicket({ projectId: 'ecom-growth' });
    const payload = JSON.parse(Buffer.from(r.data.ticket.split('.')[0], 'base64url').toString());
    assert.strictEqual(payload.scenario, 'campaign');
    assert.strictEqual(payload.project, 'ecom-growth');
    await assert.rejects(controller({ member: true }).c.trialTicket({ projectId: 'ecom-growth', scenario: 'shop' }), /场景/);
  });

  it('通用 Agent 默认是电商后端的示例仓库，最早的购物车场景仍可指定', async () => {
    const r = await controller({ member: true }).c.trialTicket({ projectId: 'general-agent', scenario: 'shop' });
    assert.strictEqual(JSON.parse(Buffer.from(r.data.ticket.split('.')[0], 'base64url').toString()).scenario, 'shop');
  });

  it('查今天还剩几次：只读不占次数，未登录返回空，非会员是 0 次', async () => {
    const { c } = controller({ member: true });
    assert.deepStrictEqual((await c.trialQuota('general-agent')).data, { limit: 10, remaining: 10, member: true });
    await c.trialTicket({ projectId: 'general-agent' });
    assert.deepStrictEqual((await c.trialQuota('general-agent')).data, { limit: 10, remaining: 9, member: true });
    assert.deepStrictEqual((await c.trialQuota('general-agent')).data, { limit: 10, remaining: 9, member: true });
    assert.deepStrictEqual((await controller().c.trialQuota('general-agent')).data, { limit: 0, remaining: 0, member: false });
    assert.strictEqual((await controller({ userId: '' }).c.trialQuota('general-agent')).data, null);
  });

  it('未登录、未知项目、未知场景、未配置都拒绝', async () => {
    await assert.rejects(controller({ userId: '' }).c.trialTicket({ projectId: 'general-agent' }), /登录/);
    await assert.rejects(controller({ member: true }).c.trialTicket({ projectId: 'nope' }), /还没有开放/);
    await assert.rejects(controller({ member: true }).c.trialTicket({ projectId: 'general-agent', scenario: 'x' }), /场景/);
    delete process.env.PROJECT_TRIAL_URL;
    await assert.rejects(controller({ member: true }).c.trialTicket({ projectId: 'general-agent' }), /暂时不可用/);
  });

  it('现场运行只对会员开放：非会员拿不到票据也不占计数，会员按项目限次', async () => {
    const { c, counts } = controller();
    await assert.rejects(c.trialTicket({ projectId: 'general-agent' }), (e: any) => e.status === 403 && /会员功能/.test(e.message));
    assert.deepStrictEqual((await c.trialQuota('general-agent')).data, { limit: 0, remaining: 0, member: false });
    assert.strictEqual(counts.size, 0);
    // 会员按项目分开计：通用 Agent 10 次、电商 3 次、评测 2 次，互不占用
    const m = controller({ member: true }).c;
    for (const [projectId, limit] of [['general-agent', 10], ['ecom-growth', 3], ['eval-evolve', 2]] as const) {
      for (let i = 0; i < limit; i++) await m.trialTicket({ projectId });
      await assert.rejects(m.trialTicket({ projectId }), /已用完/);
      assert.deepStrictEqual((await m.trialQuota(projectId)).data, { limit, remaining: 0, member: true });
    }
    assert.strictEqual((await m.trialQuota('nope')).data, null);
  });
});

describe('项目实战源码下载', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-source-'));
    fs.mkdirSync(path.join(root, 'project-source'));
    fs.writeFileSync(path.join(root, 'project-source', 'general-agent.zip'), Buffer.from('PK-fixture'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function withOss(c: ProjectHTTPService, existing: string[] = []) {
    const puts: string[] = [];
    const store = new Set(existing);
    c.ossService = {
      rawMeta: async (k: string) => (store.has(k) ? { lastModified: 'x' } : null),
      putPrivate: async (k: string, buf: Buffer, type: string) => { assert.strictEqual(type, 'application/zip'); puts.push(k); store.add(k); return buf.length; },
      signedUrl: (k: string, expires: number, filename: string) => `https://fixture.invalid/${k}?e=${expires}&f=${filename}`,
    } as any;
    c.sourceRoot = root;
    return puts;
  }

  it('会员拿到私有对象的临时链接；同一份代码只上传一次', async () => {
    const { c } = controller({ member: true });
    const puts = withOss(c);
    const r1 = await c.sourceDownload('general-agent');
    const r2 = await c.sourceDownload('general-agent');
    assert.strictEqual(puts.length, 1);
    assert.ok(/^project-source\/general-agent\/[0-9a-f]{16}\.zip$/.test(puts[0]));
    assert.strictEqual(r1.data.url, `https://fixture.invalid/${puts[0]}?e=3600&f=agent-journey-general-agent.zip`);
    assert.strictEqual(r2.data.url, r1.data.url);
    assert.strictEqual(r1.data.size, 10);
  });

  it('未登录 401、非会员 403，且都不触碰存储', async () => {
    const guest = controller({ userId: '' }).c;
    const p1 = withOss(guest);
    await assert.rejects(() => guest.sourceDownload('general-agent'), (e: any) => e.status === 401);
    const user = controller({ member: false }).c;
    const p2 = withOss(user);
    await assert.rejects(() => user.sourceDownload('general-agent'), (e: any) => e.status === 403 && /会员/.test(e.message));
    assert.deepStrictEqual([p1, p2], [[], []]);
  });

  it('未登记的项目、代码包里没有 zip 时给出明确提示', async () => {
    const { c } = controller({ member: true });
    withOss(c);
    await assert.rejects(() => c.sourceDownload('not-a-project'), /还没有开放源码下载/);
    fs.rmSync(path.join(root, 'project-source', 'general-agent.zip'));
    c.sourceRoot = path.join(root, 'nope');
    await assert.rejects(() => c.sourceDownload('general-agent'), /暂时不可用/);
  });
});

describe('项目实战在线试用：领票据、用量入库、全站熔断', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PROJECT_TRIAL_URL = 'https://trial.fixture.invalid/';
    process.env.PROJECT_TRIAL_TICKET_SECRET = 's3cret';
    process.env.PROJECT_TRIAL_CALLBACK = 'https://web.fixture.invalid';
    delete process.env.PROJECT_TRIAL_TOKEN_DAILY;
  });
  afterEach(() => { process.env = { ...saved }; });

  function setup() {
    const kv = new Map<string, string>();
    const events: any[] = []; const usage: any[] = []; const alerts: any[] = [];
    const c = new ProjectHTTPService();
    c.ctx = { userInfo: { userId: 'u1', role: 'user' } } as any;
    const bump = async (k: string, n: number) => { kv.set(k, String(Number(kv.get(k) || 0) + n)); return Number(kv.get(k)); };
    c.redisService = {
      incr: (k: string) => bump(k, 1), incrby: bump, expire: async () => 1,
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: string, ...a: any[]) => { if (a.includes('NX') && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
      del: async (k: string) => (kv.delete(k) ? 1 : 0),
    } as any;
    c.entitlementService = { check: async () => ({ allowed: true }) } as any;
    c.eventLogModel = { save: async (e: any) => { events.push(e); return e; } } as any;
    c.aiUsageLogModel = { save: async (e: any) => { usage.push(e); return e; } } as any;
    c.irisGuard = { raise: async (...a: any[]) => { alerts.push(a); return true; } } as any;
    c.now = () => new Date('2026-11-25T10:00:00+08:00');
    return { c, kv, events, usage, alerts };
  }
  const nowSec = Math.floor(new Date('2026-11-25T10:00:00+08:00').getTime() / 1000);
  const signed = (p: any, secret = 's3cret') => ({ token: signTrialTicket({ exp: nowSec + 300, ...p }, secret) });
  const open = (t: string) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());
  async function issue(c: ProjectHTTPService, projectId = 'general-agent') {
    return open((await c.trialTicket({ projectId })).data.ticket);
  }
  const dayKey = trialTokenKey(new Date('2026-11-25T10:00:00+08:00'));
  const est = (p: string) => Object.values(TRIAL_PROJECTS[p].tokenEstimate)[0];

  it('票据带回调地址，但不带用户标识（用户标识是手机号）', async () => {
    const { c } = setup();
    const t = await issue(c);
    assert.strictEqual(t.cb, 'https://web.fixture.invalid');
    assert.ok(!JSON.stringify(t).includes('u1'));
  });

  it('每个场景都有用量预估', () => {
    for (const p of Object.values(TRIAL_PROJECTS)) for (const s of p.scenarios) assert.ok(p.tokenEstimate[s] > 0, s);
  });

  it('票据只能领一次；没签发过的、签名不对的、过期的、类型不对的都领不到', async () => {
    const { c } = setup();
    const { jti } = await issue(c);
    assert.strictEqual((await c.trialClaim(signed({ typ: 'claim', jti }))).data.ok, true);
    const again = (await c.trialClaim(signed({ typ: 'claim', jti }))).data;
    assert.deepStrictEqual([again.ok, again.reason], [false, 'used']);
    assert.strictEqual((await c.trialClaim(signed({ typ: 'claim', jti: 'never' }))).data.ok, false);
    const t2 = await issue(c);
    await assert.rejects(c.trialClaim(signed({ typ: 'claim', jti: t2.jti }, 'other')), (e: any) => e.status === 403);
    await assert.rejects(c.trialClaim(signed({ typ: 'claim', jti: t2.jti, exp: nowSec - 1 })), (e: any) => e.status === 403);
    await assert.rejects(c.trialClaim(signed({ typ: 'usage', jti: t2.jti })), (e: any) => e.status === 403);
    // 浏览器手里的票据本身不能当作领取或上报的消息
    await assert.rejects(c.trialClaim({ token: signTrialTicket(t2, 's3cret') }), (e: any) => e.status === 403);
    await assert.rejects(c.trialUsage({ token: signTrialTicket(t2, 's3cret') }), (e: any) => e.status === 403);
    await assert.rejects(c.trialClaim({} as any), (e: any) => e.status === 403);
    await assert.rejects(c.trialClaim({ token: 'x.y' }), (e: any) => e.status === 403);
  });

  it('没配密钥时一律拒绝', async () => {
    const { c } = setup();
    process.env.PROJECT_TRIAL_TICKET_SECRET = '';
    await assert.rejects(c.trialClaim(signed({ typ: 'claim', jti: 'a' }, '')), (e: any) => e.status === 403);
  });

  it('用量入库：谁、哪个项目和场景、输入输出、耗时、结束原因；重复上报只记一次', async () => {
    const { c, events, usage, kv } = setup();
    const { jti } = await issue(c, 'eval-evolve');
    await c.trialClaim(signed({ typ: 'claim', jti }));
    assert.strictEqual(Number(kv.get(dayKey)), est('eval-evolve')); // 先按预估占住
    const rep = signed({ typ: 'usage', jti, stopped: 'timeout', input_tokens: 400000, output_tokens: 20000, calls: 60, estimated_calls: 2, seconds: 240.5 });
    assert.strictEqual((await c.trialUsage(rep)).data.ok, true);
    assert.strictEqual((await c.trialUsage(rep)).data.ok, true);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'project_trial_run');
    assert.strictEqual(events[0].userId, 'u1');
    assert.deepStrictEqual(events[0].props, {
      project: 'eval-evolve', scenario: 'evolve-prompt', inputTokens: 400000, outputTokens: 20000,
      calls: 60, estimatedCalls: 2, seconds: 240.5, stopped: 'timeout',
    });
    assert.deepStrictEqual([usage.length, usage[0].userId, usage[0].module, usage[0].tokenUsed], [1, 'u1', 'trial:eval-evolve', 420000]);
    assert.strictEqual(Number(kv.get(dayKey)), 420000); // 预估换成实数
  });

  it('跨天结束的运行记在领取那一天', async () => {
    const { c, kv } = setup();
    c.now = () => new Date('2026-11-25T23:59:00+08:00');
    const { jti } = await issue(c);
    const late = Math.floor(c.now().getTime() / 1000) + 600;
    await c.trialClaim(signed({ typ: 'claim', jti, exp: late }));
    c.now = () => new Date('2026-11-26T00:01:00+08:00');
    await c.trialUsage(signed({ typ: 'usage', jti, exp: late, stopped: 'finished', input_tokens: 10, output_tokens: 5 }));
    assert.strictEqual(Number(kv.get(dayKey)), 15);
    assert.strictEqual(kv.get(trialTokenKey(c.now())), undefined);
  });

  it('没领过的票据不能上报；数值不合法按 0 记', async () => {
    const { c, events } = setup();
    const { jti } = await issue(c);
    assert.strictEqual((await c.trialUsage(signed({ typ: 'usage', jti, input_tokens: 5 }))).data.ok, false);
    assert.strictEqual(events.length, 0);
    await c.trialClaim(signed({ typ: 'claim', jti }));
    await c.trialUsage(signed({ typ: 'usage', jti, stopped: 'x'.repeat(99), input_tokens: -5, output_tokens: 'abc', calls: 1e99 }));
    assert.strictEqual(events[0].props.inputTokens, 0);
    assert.strictEqual(events[0].props.outputTokens, 0);
    assert.ok(events[0].props.calls <= 1e9 && events[0].props.stopped.length <= 32);
  });

  it('入库失败时返回失败、允许重试，不会把这次记成已上报', async () => {
    const { c, events } = setup();
    const { jti } = await issue(c);
    await c.trialClaim(signed({ typ: 'claim', jti }));
    const good = c.eventLogModel;
    c.eventLogModel = { save: async () => { throw new Error('db'); } } as any;
    const rep = signed({ typ: 'usage', jti, stopped: 'finished', input_tokens: 1, output_tokens: 1 });
    await assert.rejects(c.trialUsage(rep));
    c.eventLogModel = good;
    assert.strictEqual((await c.trialUsage(rep)).data.ok, true);
    assert.strictEqual(events.length, 1);
  });

  it('全站当天用量到顶：不签票据也不占次数，已签的领不到；第二天恢复；只告警不放行', async () => {
    const { c, kv, alerts, events } = setup();
    process.env.PROJECT_TRIAL_TOKEN_DAILY = '1000000';
    const { jti } = await issue(c);
    kv.set(dayKey, '1000000');
    const got = (await c.trialClaim(signed({ typ: 'claim', jti }))).data;
    assert.deepStrictEqual([got.ok, got.reason], [false, 'budget']);
    assert.strictEqual(Number(kv.get(dayKey)), 1000000); // 没领到就不占
    const before = kv.get(trialQuotaKey('u1', c.now(), 'general-agent'));
    await assert.rejects(c.trialTicket({ projectId: 'general-agent' }), /今天.*用完/);
    assert.strictEqual(kv.get(trialQuotaKey('u1', c.now(), 'general-agent')), before);
    assert.ok(alerts.length >= 1 && alerts[0][0] === 'trial_tokens');
    assert.ok(events.some(e => e.event === 'project_trial_denied' && e.props.reason === 'budget'));
    c.now = () => new Date('2026-11-26T10:00:00+08:00');
    assert.ok((await c.trialTicket({ projectId: 'general-agent' })).data.ticket);
  });

  it('同时领也不会冲过上限：占完再看，超了就退', async () => {
    const { c, kv } = setup();
    process.env.PROJECT_TRIAL_TOKEN_DAILY = String(est('eval-evolve') + 1);
    const a = await issue(c, 'eval-evolve'); const b = await issue(c, 'eval-evolve');
    const r = await Promise.all([a, b].map(t => c.trialClaim(signed({ typ: 'claim', jti: t.jti }))));
    assert.deepStrictEqual(r.map(x => x.data.ok).sort(), [false, true]);
    assert.strictEqual(Number(kv.get(dayKey)), est('eval-evolve'));
  });

  it('没配上限时用默认值，配成非法值也用默认值', async () => {
    const { c, kv } = setup();
    process.env.PROJECT_TRIAL_TOKEN_DAILY = 'abc';
    kv.set(dayKey, '99999999');
    await assert.rejects(c.trialTicket({ projectId: 'general-agent' }), /今天.*用完/);
  });

  it('次数用完也记一条拒绝', async () => {
    const { c, events } = setup();
    for (let i = 0; i < 2; i++) await c.trialTicket({ projectId: 'eval-evolve' });
    await assert.rejects(c.trialTicket({ projectId: 'eval-evolve' }), /已用完/);
    assert.deepStrictEqual(events.map(e => [e.event, e.props.reason]), [['project_trial_denied', 'quota']]);
  });
});
