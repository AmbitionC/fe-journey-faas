import * as assert from 'assert';
import {
  IrisCreditService,
  CounterStore,
  bjDay,
  bjNextMidnight,
  creditExhaustedText,
  irisErrorCode,
} from '../src/service/ai/irisCredit';
import {
  BillingStore,
  IRIS_COST,
  IRIS_DAILY_CAP,
  IRIS_FREE_DAILY,
  IRIS_GUEST_DAILY,
  TRIAL_POINTS,
  irisPricing,
  referralPricing,
  REFERRAL_REWARD,
} from '../src/mcp/billing';

/** 内存版 Redis 计数器 */
class FakeCounter implements CounterStore {
  m = new Map<string, number>();
  async incr(k: string) {
    const n = (this.m.get(k) || 0) + 1;
    this.m.set(k, n);
    return n;
  }
  async decr(k: string) {
    const n = (this.m.get(k) || 0) - 1;
    this.m.set(k, n);
    return n;
  }
  async expire() {
    return 1;
  }
  async get(k: string) {
    return this.m.has(k) ? String(this.m.get(k)) : null;
  }
}

/** 内存版计费账户（与 BillingStore 的语义一致：activate 幂等送体验点、charge 原子、refund 回补） */
class FakeBilling {
  accounts = new Map<string, number>();
  ledger: { userId: string; delta: number; reason: string; ref?: string }[] = [];
  async activate(userId: string) {
    const created = !this.accounts.has(userId);
    if (created) {
      this.accounts.set(userId, TRIAL_POINTS);
      this.ledger.push({ userId, delta: TRIAL_POINTS, reason: 'trial' });
    }
    return { account: await this.getAccount(userId), created };
  }
  async getAccount(userId: string) {
    return this.accounts.has(userId) ? { user_id: userId, points: this.accounts.get(userId)!, tier: 'free' } : null;
  }
  async charge(userId: string, cost: number, tool: string) {
    const p = this.accounts.get(userId) ?? 0;
    if (p < cost) return null;
    this.accounts.set(userId, p - cost);
    this.ledger.push({ userId, delta: -cost, reason: 'call', ref: tool });
    return p - cost;
  }
  async refund(userId: string, cost: number, tool: string) {
    this.accounts.set(userId, (this.accounts.get(userId) ?? 0) + cost);
    this.ledger.push({ userId, delta: cost, reason: 'refund', ref: tool });
  }
}

class FakeAnalytics {
  events: any[] = [];
  async track(e: any) {
    this.events.push(e);
  }
}

function make(opts: { free?: boolean } = {}) {
  const svc = new IrisCreditService();
  const counter = new FakeCounter();
  const billing = new FakeBilling();
  const analytics = new FakeAnalytics();
  svc.counter = counter;
  svc.billing = billing as unknown as BillingStore;
  svc.analytics = analytics as any;
  svc.membershipConfig = opts.free
    ? { freeUntil: '2099-01-01T00:00:00+08:00', freeForAll: false }
    : ({ freeUntil: '2026-08-01T00:00:00+08:00', freeForAll: false } as any);
  svc.now = () => new Date('2026-11-02T03:00:00Z');
  return { svc, counter, billing, analytics };
}

async function rejects(p: Promise<any>, prefix: string) {
  try {
    await p;
  } catch (e: any) {
    assert.ok(String(e.message).startsWith(prefix), `expected ${prefix}, got ${e.message}`);
    return e;
  }
  assert.fail(`expected rejection ${prefix}`);
}

describe('Iris 计点（IrisCreditService）', () => {
  it('价目常量：模式成本与前端读到的 pricing.iris 一致', () => {
    const p = irisPricing();
    assert.deepStrictEqual(p.costs, IRIS_COST);
    assert.strictEqual(p.freeDaily, IRIS_FREE_DAILY);
    assert.strictEqual(p.guestDaily, IRIS_GUEST_DAILY);
    assert.deepStrictEqual(p.memberOnly, ['interview', 'report']);
    assert.ok(IRIS_COST.report > IRIS_COST.think && IRIS_COST.think > IRIS_COST.chat);
    const r = referralPricing();
    assert.strictEqual(r.inviter, REFERRAL_REWARD.inviter);
    assert.strictEqual(r.memberBonus, REFERRAL_REWARD.memberBonus);
  });

  it('限免期：不计不扣', async () => {
    const { svc, billing } = make({ free: true });
    const c = await svc.begin('13800000000', false, 'report');
    assert.strictEqual(c.charged, 0);
    assert.strictEqual(billing.accounts.size, 0);
    const q = await svc.quota('13800000000', false);
    assert.strictEqual(q.isMember, true);
    assert.strictEqual(q.limit, null);
  });

  it('游客：只能普通问答，每天 N 次，不进账户', async () => {
    const { svc, billing } = make();
    for (let i = 0; i < IRIS_GUEST_DAILY; i++) {
      const c = await svc.begin('guest:1.2.3.4', false, 'chat');
      assert.strictEqual(c.free, true);
      assert.strictEqual(c.charged, 0);
    }
    await rejects(svc.begin('guest:1.2.3.4', false, 'chat'), 'RATE_LIMIT:');
    await rejects(svc.begin('guest:9.9.9.9', false, 'think'), 'RATE_LIMIT:');
    assert.strictEqual(billing.accounts.size, 0);
    const q = await svc.quota('guest:1.2.3.4', false);
    assert.strictEqual(q.guest, true);
    assert.strictEqual(q.freeUsed, IRIS_GUEST_DAILY);
    assert.strictEqual(q.points, null);
  });

  it('登录用户：前 N 次免费，之后自动开通送体验点并按模式扣点；失败退点', async () => {
    const { svc, billing, analytics } = make();
    const u = '13900000001';
    for (let i = 0; i < IRIS_FREE_DAILY; i++) {
      const c = await svc.begin(u, false, 'chat');
      assert.strictEqual(c.free, true);
    }
    assert.strictEqual(billing.accounts.size, 0, '免费次不触发开户');

    const c4 = await svc.begin(u, false, 'chat');
    assert.strictEqual(c4.free, false);
    assert.strictEqual(c4.charged, IRIS_COST.chat);
    assert.strictEqual(billing.accounts.get(u), TRIAL_POINTS - IRIS_COST.chat);
    assert.ok(analytics.events.some(e => e.event === 'account_activated' && e.props.via === 'iris'));
    assert.ok(analytics.events.some(e => e.event === 'trial_granted'));

    const t = await svc.begin(u, false, 'think');
    assert.strictEqual(t.charged, IRIS_COST.think);
    assert.strictEqual(billing.accounts.get(u), TRIAL_POINTS - IRIS_COST.chat - IRIS_COST.think);
    assert.ok(billing.ledger.some(l => l.ref === 'iris_think' && l.delta === -IRIS_COST.think));

    await t.refund();
    await t.refund(); // 幂等
    assert.strictEqual(billing.accounts.get(u), TRIAL_POINTS - IRIS_COST.chat);

    const q = await svc.quota(u, false);
    assert.strictEqual(q.freeUsed, IRIS_FREE_DAILY);
    assert.strictEqual(q.points, TRIAL_POINTS - IRIS_COST.chat);
    assert.strictEqual(q.activated, true);
    assert.strictEqual(q.dailyCap, IRIS_DAILY_CAP.free);
  });

  it('免费次退回：上游失败不消耗当天的免费额度', async () => {
    const { svc, counter } = make();
    const c = await svc.begin('13900000002', false, 'chat');
    assert.strictEqual(c.free, true);
    await c.refund();
    const key = [...counter.m.keys()].find(k => k.startsWith('iris:free:'))!;
    assert.strictEqual(counter.m.get(key), 0);
  });

  it('会员专享：非会员模拟面试 / 报告被拒，会员按成本扣点', async () => {
    const { svc, billing } = make();
    await rejects(svc.begin('13900000003', false, 'interview'), 'MEMBER_ONLY:');
    await rejects(svc.begin('13900000003', false, 'report'), 'MEMBER_ONLY:');
    const i = await svc.begin('13900000003', true, 'interview');
    assert.strictEqual(i.charged, IRIS_COST.interview);
    const r = await svc.begin('13900000003', true, 'report');
    assert.strictEqual(r.charged, IRIS_COST.report);
    assert.strictEqual(billing.accounts.get('13900000003'), TRIAL_POINTS - IRIS_COST.interview - IRIS_COST.report);
  });

  it('点数不足：拒绝并记 credit_exhausted，文案带余额与出路', async () => {
    const { svc, billing, analytics } = make();
    const u = '13900000004';
    await billing.activate(u);
    billing.accounts.set(u, IRIS_COST.report - 1);
    const e = await rejects(svc.begin(u, true, 'report'), 'CREDIT_EXHAUSTED:');
    assert.ok(e.message.includes(`余额 ${IRIS_COST.report - 1} 点`));
    assert.strictEqual(billing.accounts.get(u), IRIS_COST.report - 1, '不足时一分不扣');
    const ev = analytics.events.find(x => x.event === 'credit_exhausted');
    assert.ok(ev && ev.props.tool === 'iris_report' && ev.props.via === 'iris');
    assert.strictEqual(irisErrorCode(e.message), 'CREDIT_EXHAUSTED');
    assert.strictEqual(irisErrorCode(creditExhaustedText(1, 0)), 'CREDIT_EXHAUSTED');
    assert.strictEqual(irisErrorCode('RATE_LIMIT:x'), 'RATE_LIMIT');
    assert.strictEqual(irisErrorCode('MEMBER_ONLY:x'), 'MEMBER_ONLY');
    assert.strictEqual(irisErrorCode('boom'), null);
  });

  it('每日总上限：成本保险丝', async () => {
    const { svc, counter } = make();
    const u = '13900000005';
    counter.m.set(`iris:cap:${bjDay(new Date('2026-11-02T03:00:00Z'))}:${u}`, IRIS_DAILY_CAP.free);
    await rejects(svc.begin(u, false, 'chat'), 'RATE_LIMIT:');
  });

  it('Redis 不可用：计数失效但不拒绝（按无免费次直接扣点）', async () => {
    const { svc, billing } = make();
    svc.counter = {
      incr: async () => {
        throw new Error('down');
      },
      expire: async () => 0,
      get: async () => {
        throw new Error('down');
      },
    };
    const c = await svc.begin('13900000006', false, 'chat');
    assert.strictEqual(c.charged, IRIS_COST.chat);
    assert.strictEqual(billing.accounts.get('13900000006'), TRIAL_POINTS - IRIS_COST.chat);
  });

  it('北京日边界', () => {
    assert.strictEqual(bjDay(new Date('2026-11-02T15:59:00Z')), '2026-11-02');
    assert.strictEqual(bjDay(new Date('2026-11-02T16:00:00Z')), '2026-11-03');
    assert.strictEqual(bjNextMidnight(new Date('2026-11-02T03:00:00Z')), '2026-11-02T16:00:00.000Z');
  });
});
