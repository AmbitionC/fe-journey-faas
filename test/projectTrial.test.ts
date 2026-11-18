import * as assert from 'assert';
import * as crypto from 'crypto';
import { ProjectHTTPService } from '../src/function/project';
import { signTrialTicket, trialDay, trialQuotaKey } from '../src/service/project/trial';

function controller(opts: { userId?: string; member?: boolean } = {}) {
  const counts = new Map<string, number>();
  const c = new ProjectHTTPService();
  const userId = opts.userId === undefined ? 'u1' : opts.userId;
  c.ctx = { userInfo: userId ? { userId, role: 'user' } : undefined } as any;
  c.redisService = {
    incr: async (k: string) => { counts.set(k, (counts.get(k) || 0) + 1); return counts.get(k); },
    expire: async () => 1,
  } as any;
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
    assert.strictEqual(trialQuotaKey('u1', new Date('2026-11-18T00:00:00+08:00')), 'project:trial:2026-11-18:u1');
  });

  it('登录用户拿到票据和试用地址，返回剩余次数', async () => {
    const { c } = controller();
    const r = await c.trialTicket({ projectId: 'general-agent' });
    assert.strictEqual(r.data.url, 'https://trial.fixture.invalid/run');
    assert.strictEqual(r.data.remaining, 2);
    const payload = JSON.parse(Buffer.from(r.data.ticket.split('.')[0], 'base64url').toString());
    assert.strictEqual(payload.scenario, 'shop');
    assert.strictEqual(payload.exp, Math.floor(new Date('2026-11-18T23:30:00+08:00').getTime() / 1000) + 120);
  });

  it('未登录、未知项目、未知场景、未配置都拒绝', async () => {
    await assert.rejects(controller({ userId: '' }).c.trialTicket({ projectId: 'general-agent' }), /登录/);
    await assert.rejects(controller().c.trialTicket({ projectId: 'nope' }), /还没有开放/);
    await assert.rejects(controller().c.trialTicket({ projectId: 'general-agent', scenario: 'x' }), /场景/);
    delete process.env.PROJECT_TRIAL_URL;
    await assert.rejects(controller().c.trialTicket({ projectId: 'general-agent' }), /暂时不可用/);
  });

  it('普通用户每天 3 次，会员 20 次', async () => {
    const { c } = controller();
    for (let i = 0; i < 3; i++) await c.trialTicket({ projectId: 'general-agent' });
    await assert.rejects(c.trialTicket({ projectId: 'general-agent' }), /已用完/);
    const m = controller({ member: true }).c;
    for (let i = 0; i < 20; i++) await m.trialTicket({ projectId: 'general-agent' });
    await assert.rejects(m.trialTicket({ projectId: 'general-agent' }), /已用完/);
  });
});
