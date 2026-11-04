import * as assert from 'assert';
import {
  describeEntry,
  entryFromProps,
  refHost,
  sanitizeEntry,
} from '../src/mcp/attribution';
import { render, PayEvent } from '../src/mcp/payNotify';
import { handleMcpHttp, McpRuntime } from '../src/mcp/http';
import type { TrackInput } from '../src/mcp/analytics';

/** 付费来源（2026-11-04）：下单带 entry → order_created / order_paid / 收款邮件都能看到这一单从哪来。 */

const HALF = () => new Date('2026-11-15T12:00:00+08:00');

describe('付费来源：清洗', () => {
  it('只留白名单字段，字符串截断、去掉怪字符', () => {
    const e = sanitizeEntry({
      entryPage: 'member',
      entryCta: 'reading_quota_hint_knowledge',
      entryFrom: '<script>alert(1)</script>',
      ftRef: 'https://www.bing.com/search?q=agent',
      ftLanding: '/developer',
      ftCh: 'xhs-note1104',
      ftDays: 2.7,
      device: 'desktop',
      anonId: 'a_mhk3abc12345',
      evil: 'drop me',
      nested: { a: 1 },
    })!;
    assert.deepStrictEqual(e, {
      entryPage: 'member',
      entryCta: 'reading_quota_hint_knowledge',
      entryFrom: 'scriptalert1/script',
      ftRef: 'bing.com',
      ftLanding: '/developer',
      ftCh: 'xhs-note1104',
      ftDays: 2,
      device: 'desktop',
      anonId: 'a_mhk3abc12345',
    });
  });

  it('非对象 / 空对象 / 非法设备与访客 id 都丢掉', () => {
    assert.strictEqual(sanitizeEntry(null), null);
    assert.strictEqual(sanitizeEntry('x'), null);
    assert.strictEqual(sanitizeEntry([1]), null);
    assert.strictEqual(sanitizeEntry({ device: 'tv', anonId: 'u1; drop', ftDays: -1 }), null);
    assert.strictEqual(sanitizeEntry({ entryCta: 'x'.repeat(200) })!.entryCta!.length, 64);
  });

  it('来源域名：URL / 裸域名 / 垃圾', () => {
    assert.strictEqual(refHost('https://www.xiaohongshu.com/explore'), 'xiaohongshu.com');
    assert.strictEqual(refHost('Bing.com'), 'bing.com');
    assert.strictEqual(refHost('not a host!'), undefined);
    assert.strictEqual(refHost(''), undefined);
  });
});

describe('付费来源：人话描述', () => {
  it('站内入口 + 首触来源 + 设备', () => {
    assert.strictEqual(
      describeEntry({ entryPage: 'member', entryCta: 'reading_quota_hint_knowledge', ftRef: 'bing.com', ftLanding: '/developer', ftDays: 2, device: 'desktop' }),
      '知识点限看提示 → Agent Journey 会员页；首次来自 bing.com（落地 /developer，2 天前） · 电脑'
    );
    assert.strictEqual(
      describeEntry({ entryPage: 'invest_skills', entryFrom: 'credit_exhausted', ftCh: 'xhs', ftDays: 0, device: 'mobile' }),
      'Skill 点数用完提示 → Invest Journey 数据服务页；首次来自 渠道 xhs（当天） · 手机'
    );
    assert.strictEqual(describeEntry({ entryPage: 'member' }), 'Agent Journey 会员页；首次是直接访问');
    assert.strictEqual(describeEntry(null), '未记录（下单页面没带来源）');
    assert.strictEqual(describeEntry({ entryCta: 'brand_new_button' }), 'brand_new_button；首次是直接访问');
    assert.strictEqual(
      describeEntry({ entryPage: 'invest_skills', entryCta: 'page:/market', ftRef: 'xiaohongshu.com', ftDays: 0, device: 'mobile' }),
      '市场总览页 → Invest Journey 数据服务页；首次来自 xiaohongshu.com（当天） · 手机'
    );
    assert.strictEqual(describeEntry({ entryCta: 'page:/foo' }), '站内 /foo 页；首次是直接访问');
  });

  it('从事件 props 取回来源字段，不带订单字段', () => {
    assert.deepStrictEqual(
      entryFromProps({ orderNo: 'MJ1', sku: 'member_month', site: 'agent', entryCta: 'header_desktop', ftDays: 0 }),
      { entryCta: 'header_desktop', ftDays: 0 }
    );
    assert.strictEqual(entryFromProps({ orderNo: 'MJ1' }), null);
  });

  it('收款邮件正文带「来源」一行，没有来源时不出这一行', () => {
    const ev: PayEvent = { kind: 'paid', channel: 'alipay', orderNo: 'MJ9', sku: 'member_month', skuName: '会员月卡', amountCents: 1450, userId: '42' };
    const buyer = { phone: '13812345678', role: 'user' };
    const withSrc = render({ ...ev, source: '知识点限看提示 → Agent Journey 会员页' }, buyer, [], new Date());
    assert.ok(withSrc.text.includes('来源：知识点限看提示 → Agent Journey 会员页'));
    assert.ok(!render(ev, buyer, [], new Date()).text.includes('来源：'));
  });
});

/** 下单 → 自报 → 自动发放：来源写进 order_created，再跟着 order_paid 和提醒走。 */
function fakeRt() {
  const events: TrackInput[] = [];
  const notified: PayEvent[] = [];
  const order = { order_no: 'MJ20261115ABCDEF12', user_id: 'u1', sku: 'member_month', amount_cents: 1450, status: 'pending' as string };
  const rt: McpRuntime = {
    store: {} as any,
    billing: {
      activate: async () => ({ created: false }),
      createOrder: async () => ({ ...order, reused: false }),
      reportPaid: async () => { order.status = 'reported'; return true; },
      getOrder: async () => ({ ...order }),
      fulfill: async () => { order.status = 'paid'; return 'ok'; },
    } as any,
    agentDeps: () => ({} as any),
    investDeps: () => ({} as any),
    isAdmin: async () => false,
    userIdOf: async () => 'u1',
    now: HALF,
    autoFulfill: true,
    payNotify: { notify: async (ev: PayEvent) => { notified.push(ev); return { sms: 'unconfigured', mail: 'sent', test: false }; } } as any,
    analytics: {
      track: async (e: TrackInput) => { events.push(e); },
      trackMany: async () => 0,
      // 与真实实现同口径：按订单号找 order_created 的 props
      orderEntry: async (no: string) => {
        const c = events.find(e => e.event === 'order_created' && e.props!.orderNo === no);
        return c ? { site: c.props!.site, entry: entryFromProps(c.props) } : null;
      },
    } as any,
  } as any;
  return { rt, events, notified };
}

async function post(rt: McpRuntime, path: string, body: any) {
  const req: any = { method: 'POST', headers: {} };
  const res: any = {
    statusCode: 0, headers: {} as any, body: '',
    setHeader(k: string, v: any) { this.headers[k.toLowerCase()] = v; },
    end(b?: any) { this.body = b ? String(b) : ''; },
  };
  await handleMcpHttp(req, res, new URL(`http://x${path}`), rt, Buffer.from(JSON.stringify(body)));
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

describe('付费来源：下单到到账全链路', () => {
  it('order_created 带来源与访客 id，order_paid 和收款提醒带同一份来源', async () => {
    const { rt, events, notified } = fakeRt();
    const r = await post(rt, '/mcp/me/orders', {
      sku: 'member_month',
      site: 'agent',
      returnPath: '/membership',
      entry: { entryPage: 'member', entryCta: 'reading_quota_hint_knowledge', ftRef: 'https://www.bing.com/', ftLanding: '/knowledge', ftDays: 1, device: 'desktop', anonId: 'a_abc12345' },
    });
    assert.strictEqual(r.status, 200);
    const c = events.find(e => e.event === 'order_created')!;
    assert.strictEqual(c.product, 'agent');
    assert.strictEqual(c.anonId, 'a_abc12345');
    assert.deepStrictEqual(
      [c.props!.entryPage, c.props!.entryCta, c.props!.ftRef, c.props!.ftLanding, c.props!.ftDays, c.props!.device, c.props!.anonId],
      ['member', 'reading_quota_hint_knowledge', 'bing.com', '/knowledge', 1, 'desktop', undefined]
    );

    await post(rt, '/mcp/me/orders/paid', { orderNo: 'MJ20261115ABCDEF12' });
    const p = events.find(e => e.event === 'order_paid')!;
    assert.strictEqual(p.product, 'agent');
    assert.deepStrictEqual([p.props!.site, p.props!.entryCta, p.props!.ftRef], ['agent', 'reading_quota_hint_knowledge', 'bing.com']);
    assert.ok(notified.length >= 1);
    assert.ok(notified.every(n => /知识点限看提示 → Agent Journey 会员页；首次来自 bing\.com/.test(String(n.source))));
  });

  it('前端没带来源（旧版本页面）照常下单，邮件写「未记录」', async () => {
    const { rt, events, notified } = fakeRt();
    const r = await post(rt, '/mcp/me/orders', { sku: 'member_month', site: 'invest' });
    assert.strictEqual(r.status, 200);
    const c = events.find(e => e.event === 'order_created')!;
    assert.strictEqual(c.props!.entryCta, undefined);
    await post(rt, '/mcp/me/orders/paid', { orderNo: 'MJ20261115ABCDEF12' });
    assert.ok(notified.every(n => n.source === '未记录（下单页面没带来源）'));
  });

  it('查来源出错不影响发货', async () => {
    const { rt, events } = fakeRt();
    (rt.analytics as any).orderEntry = async () => { throw new Error('db down'); };
    await post(rt, '/mcp/me/orders', { sku: 'member_month' });
    await post(rt, '/mcp/me/orders/paid', { orderNo: 'MJ20261115ABCDEF12' });
    assert.ok(events.some(e => e.event === 'order_paid'));
  });
});
