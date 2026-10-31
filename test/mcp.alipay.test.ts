import * as assert from 'assert';
import { generateKeyPairSync } from 'crypto';
import {
  checkPaid,
  extractResponseNode,
  loadAlipayConfig,
  pagePayUrl,
  queryTrade,
  rsaSign,
  rsaVerify,
  signContent,
  verifyNotify,
  loadPrivateKey,
} from '../src/mcp/alipay';
import { handleAlipayNotify, handleSelfServe, pricing } from '../src/mcp/selfServe';

/**
 * 支付宝网页收款：用本地生成的两对密钥分别扮演「我们的应用」和「支付宝」，
 * 不连支付宝网关也能把签名、验签、金额核对、发货幂等全部走一遍。
 */

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const strip = (s: string) =>
    s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return {
    priv8: strip(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ),
    priv1: strip(
      privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    ),
    pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    pub: strip(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    keyObj: privateKey,
  };
}

const app = keyPair();
const ali = keyPair();
const cfg = loadAlipayConfig({
  ALIPAY_APP_ID: '2021000000000001',
  ALIPAY_PRIVATE_KEY: app.priv8,
  ALIPAY_PUBLIC_KEY: ali.pub,
  ALIPAY_NOTIFY_URL: 'https://fc.example/mcp/pay/alipay/notify',
})!;

/** 以「支付宝」的私钥签一条通知，模拟支付宝服务器推送。 */
function aliNotify(fields: Record<string, string>) {
  const p: Record<string, string> = {
    app_id: cfg.appId,
    charset: 'utf-8',
    sign_type: 'RSA2',
    notify_type: 'trade_status_sync',
    ...fields,
  };
  p.sign = rsaSign(signContent(p, ['sign', 'sign_type']), ali.keyObj);
  return p;
}

function fakeRuntime(orders: Record<string, any>) {
  const fulfilled: string[] = [];
  const billing: any = {
    getOrder: async (no: string) => orders[no] || null,
    fulfill: async (no: string, actor: string) => {
      const o = orders[no];
      if (!o) return 'not_found';
      if (!['pending', 'self_reported'].includes(o.status)) return 'already';
      o.status = 'paid';
      o.handled_by = actor;
      fulfilled.push(`${no}:${actor}`);
      return 'ok';
    },
  };
  return { rt: { alipay: cfg, billing } as any, fulfilled };
}

function fakeRes() {
  const r: any = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
    end(s: string) {
      r.body = s;
    },
  };
  return r;
}

describe('MCP 支付宝网页收款', () => {
  it('未配置齐三项时视为未开通', () => {
    assert.strictEqual(loadAlipayConfig({ ALIPAY_APP_ID: 'x' }), null);
    assert.deepStrictEqual(pricing(new Date(), false).payChannels, ['wechat_qr']);
    assert.deepStrictEqual(pricing(new Date(), true).payChannels, ['alipay', 'wechat_qr']);
  });

  it('私钥兼容 PKCS#8 与 PKCS#1、带不带 PEM 头尾', () => {
    for (const k of [app.priv8, app.priv1]) {
      const s = rsaSign('a=1', loadPrivateKey(k));
      assert.ok(rsaVerify('a=1', s, app.pubPem));
    }
  });

  it('待签名串按 key 排序并去掉空值与 sign', () => {
    assert.strictEqual(
      signContent({ b: '2', a: '1', sign: 'x', c: '' }),
      'a=1&b=2'
    );
  });

  it('付款链接用应用私钥签名，金额取订单金额', () => {
    const url = new URL(
      pagePayUrl(cfg, {
        orderNo: 'MJ20261031ABCDEF12',
        amountCents: 1990,
        subject: 'Journey 开发者服务 · 入门/月',
      })
    );
    const p: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (p[k] = v));
    assert.strictEqual(p.method, 'alipay.trade.page.pay');
    assert.strictEqual(p.notify_url, cfg.notifyUrl);
    const biz = JSON.parse(p.biz_content);
    assert.strictEqual(biz.total_amount, '19.90');
    assert.strictEqual(biz.product_code, 'FAST_INSTANT_TRADE_PAY');
    assert.ok(!/[/=&]/.test(biz.subject));
    assert.ok(rsaVerify(signContent(p), p.sign, app.pubPem));
  });

  it('通知验签：支付宝签的通过，被篡改或别人签的不通过', () => {
    const n = aliNotify({ out_trade_no: 'MJ1', total_amount: '19.90' });
    assert.ok(verifyNotify(cfg, n));
    assert.ok(!verifyNotify(cfg, { ...n, total_amount: '0.01' }));
    const forged = { ...n };
    forged.sign = rsaSign(signContent(forged, ['sign', 'sign_type']), app.keyObj);
    assert.ok(!verifyNotify(cfg, forged));
  });

  it('能否发货：状态、应用、金额都要对上', () => {
    const o = { order_no: 'MJ1', amount_cents: 1990 };
    const ok = {
      app_id: cfg.appId,
      out_trade_no: 'MJ1',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '19.90',
      trade_no: 'T1',
    };
    assert.deepStrictEqual(checkPaid(cfg, ok, o), { ok: true, tradeNo: 'T1' });
    assert.strictEqual(
      checkPaid(cfg, { ...ok, total_amount: '0.01' }, o).reason,
      'amount_mismatch'
    );
    assert.strictEqual(
      checkPaid(cfg, { ...ok, trade_status: 'WAIT_BUYER_PAY' }, o).reason,
      'status_WAIT_BUYER_PAY'
    );
    assert.strictEqual(
      checkPaid(cfg, { ...ok, app_id: 'other' }, o).reason,
      'app_id_mismatch'
    );
    assert.strictEqual(checkPaid(cfg, ok, null).reason, 'order_not_found');
  });

  it('通知到达即发货，重复通知不重复发货', async () => {
    const { rt, fulfilled } = fakeRuntime({
      MJ1: { order_no: 'MJ1', amount_cents: 1990, status: 'self_reported' },
    });
    const body = Buffer.from(
      new URLSearchParams(
        aliNotify({
          out_trade_no: 'MJ1',
          total_amount: '19.90',
          trade_status: 'TRADE_SUCCESS',
          trade_no: '2026103122001',
        })
      ).toString()
    );
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      await handleAlipayNotify(res, rt, body, 'POST');
      assert.strictEqual(res.body, 'success');
    }
    assert.deepStrictEqual(fulfilled, ['MJ1:alipay:2026103122001']);
  });

  it('金额不符的通知不发货；伪造通知回 failure', async () => {
    const { rt, fulfilled } = fakeRuntime({
      MJ2: { order_no: 'MJ2', amount_cents: 13900, status: 'pending' },
    });
    const n = aliNotify({
      out_trade_no: 'MJ2',
      total_amount: '0.01',
      trade_status: 'TRADE_SUCCESS',
      trade_no: 'T2',
    });
    let res = fakeRes();
    await handleAlipayNotify(
      res,
      rt,
      Buffer.from(new URLSearchParams(n).toString()),
      'POST'
    );
    assert.strictEqual(res.body, 'success');
    res = fakeRes();
    await handleAlipayNotify(
      res,
      rt,
      Buffer.from(
        new URLSearchParams({ ...n, total_amount: '139.00' }).toString()
      ),
      'POST'
    );
    assert.strictEqual(res.body, 'failure');
    assert.deepStrictEqual(fulfilled, []);
  });

  it('查单：截取响应原文验签，成功才采信', async () => {
    const node =
      '{"code":"10000","msg":"Success","out_trade_no":"MJ3","trade_no":"T3","trade_status":"TRADE_SUCCESS","total_amount":"6.90"}';
    const sign = rsaSign(node, ali.keyObj);
    const raw = `{"alipay_trade_query_response":${node},"sign":"${sign}"}`;
    assert.strictEqual(
      extractResponseNode(raw, 'alipay_trade_query_response'),
      node
    );
    const fetchOk: any = async () => ({ text: async () => raw });
    const r = await queryTrade(cfg, 'MJ3', fetchOk);
    assert.strictEqual(r.trade_status, 'TRADE_SUCCESS');

    const tampered = raw.replace('6.90', '0.01');
    const fetchBad: any = async () => ({ text: async () => tampered });
    await assert.rejects(queryTrade(cfg, 'MJ3', fetchBad), /验签失败/);
  });

  it('付完跳回时主动查单发货，只认自己的订单', async () => {
    const orders: Record<string, any> = {
      MJ4: {
        order_no: 'MJ4',
        user_id: 'u1',
        sku: 'x',
        amount_cents: 690,
        status: 'pending',
      },
    };
    const { rt, fulfilled } = fakeRuntime(orders);
    rt.userIdOf = async () => 'u1';
    const node =
      '{"code":"10000","msg":"Success","out_trade_no":"MJ4","trade_no":"T4","trade_status":"TRADE_SUCCESS","total_amount":"6.90"}';
    const raw = `{"alipay_trade_query_response":${node},"sign":"${rsaSign(
      node,
      ali.keyObj
    )}"}`;
    // queryTrade 用模块内的 node-fetch；这里替换网关为本地桩，避免真连支付宝
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http');
    const srv = http.createServer((_q: any, s: any) => s.end(raw));
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    rt.alipay = { ...cfg, gateway: `http://127.0.0.1:${srv.address().port}/` };
    try {
      const call = async (uid: string) => {
        rt.userIdOf = async () => uid;
        const res = fakeRes();
        await handleSelfServe(
          { headers: {} } as any,
          res,
          new URL('http://x/mcp/me/orders/alipay/sync'),
          rt,
          Buffer.from(JSON.stringify({ orderNo: 'MJ4' })),
          'POST'
        );
        return { status: res.statusCode, body: JSON.parse(res.body) };
      };
      assert.strictEqual((await call('u2')).status, 404);
      const ok = await call('u1');
      assert.strictEqual(ok.body.data.status, 'paid');
      assert.strictEqual(ok.body.data.paidVia, 'alipay');
      assert.deepStrictEqual(fulfilled, ['MJ4:alipay:T4']);
    } finally {
      srv.close();
    }
  });
});
