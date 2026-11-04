import * as assert from 'assert';
import { handleSelfServe, pricing, WECHAT_QR_ENABLED } from '../src/mcp/selfServe';
import { fakeAlipayCfg } from './fakeAlipay';

/** 微信收款关闭（owner 2026-11-04「微信没有后台检验，微信的付费通道都先关闭」）。 */

const HALF = new Date('2026-11-15T12:00:00+08:00');

function rt(alipay: any = { ...fakeAlipayCfg, maxCents: 5000 }) {
  const created: string[] = [];
  const r: any = {
    alipay,
    now: () => HALF,
    userIdOf: async () => 'u1',
    billing: {
      activate: async () => ({ created: false }),
      createOrder: async (_u: string, sku: any, amount: number) => {
        created.push(sku.sku);
        return { order_no: 'MJ20261115ABCDEF12', user_id: 'u1', sku: sku.sku, amount_cents: amount, status: 'pending', reused: false };
      },
      reportPaid: async () => { throw new Error('不该被调用'); },
    },
  };
  return { r, created };
}

async function post(r: any, path: string, body: any) {
  const res: any = { statusCode: 0, body: '', setHeader() {}, end(b?: any) { this.body = String(b || ''); } };
  await handleSelfServe({ headers: {} } as any, res, new URL(`http://x${path}`), r, Buffer.from(JSON.stringify(body)), 'POST');
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

describe('微信收款关闭', () => {
  it('开关是关的；价目只给支付宝，超过单笔限额的年卡显示缺货、不可买', () => {
    assert.strictEqual(WECHAT_QR_ENABLED, false);
    const p = pricing(HALF, true, 5000);
    assert.deepStrictEqual(p.payChannels, ['alipay']);
    const year = p.skus.find(s => s.sku === 'member_year')!;
    const month = p.skus.find(s => s.sku === 'member_month')!;
    assert.ok(year.price > 50);
    assert.deepStrictEqual([year.soldOut, year.purchasable], [true, false]);
    assert.deepStrictEqual([month.soldOut, month.purchasable], [false, true]);
    // 提额后（限额 0＝不限）年卡恢复
    assert.strictEqual(pricing(HALF, true, 0).skus.find(s => s.sku === 'member_year')!.soldOut, false);
    // 支付宝没开通：全部缺货
    assert.ok(pricing(HALF, false).skus.every(s => s.soldOut && !s.purchasable));
  });

  it('下年卡单直接回缺货、不建订单；下月卡单正常、不再带微信收款码', async () => {
    const { r, created } = rt();
    const y = await post(r, '/mcp/me/orders', { sku: 'member_year' });
    assert.deepStrictEqual([y.status, y.json.code], [400, 'sold_out']);
    assert.match(y.json.message, /缺货/);
    const m = await post(r, '/mcp/me/orders', { sku: 'member_month' });
    assert.strictEqual(m.status, 200);
    assert.ok(m.json.data.alipayUrl);
    assert.strictEqual(m.json.data.qr, undefined);
    assert.strictEqual(m.json.data.howToPay, undefined);
    assert.deepStrictEqual(created, ['member_month']);
  });

  it('「我已支付」（微信自报）接口拒绝，不改订单', async () => {
    const { r } = rt();
    const x = await post(r, '/mcp/me/orders/paid', { orderNo: 'MJ20261115ABCDEF12' });
    assert.deepStrictEqual([x.status, x.json.code], [410, 'wechat_closed']);
  });
});
