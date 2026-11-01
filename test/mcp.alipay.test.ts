import * as assert from 'assert';
import { generateKeyPairSync } from 'crypto';
import {
  appPublicKeyOf,
  checkPaid,
  extractResponseNode,
  keyFingerprint,
  selfCheck,
  loadAlipayConfig,
  pagePayUrl,
  queryTrade,
  rsaSign,
  rsaVerify,
  signContent,
  verifyNotify,
  loadPrivateKey,
} from '../src/mcp/alipay';
import {
  handleAlipayNotify,
  handleSelfServe,
  pricing,
} from '../src/mcp/selfServe';

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
    assert.deepStrictEqual(pricing(new Date(), false).payChannels, [
      'wechat_qr',
    ]);
    assert.deepStrictEqual(pricing(new Date(), true).payChannels, [
      'alipay',
      'wechat_qr',
    ]);
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
    assert.strictEqual(p.return_url, cfg.returnUrl);
  });

  it('付款链接可按下单站点指定回跳页（Invest 的单付完回 Invest 站）', () => {
    const url = new URL(
      pagePayUrl(cfg, {
        orderNo: 'MJ20261101ABCDEF12',
        amountCents: 1450,
        subject: 'Invest Journey 会员与点数 · 会员月卡',
        returnUrl: 'https://invest-journey.vercel.app/skills',
      })
    );
    const p: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (p[k] = v));
    assert.strictEqual(p.return_url, 'https://invest-journey.vercel.app/skills');
    assert.ok(rsaVerify(signContent(p), p.sign, app.pubPem));
  });

  it('通知验签：支付宝签的通过，被篡改或别人签的不通过', () => {
    const n = aliNotify({ out_trade_no: 'MJ1', total_amount: '19.90' });
    assert.ok(verifyNotify(cfg, n));
    assert.ok(!verifyNotify(cfg, { ...n, total_amount: '0.01' }));
    const forged = { ...n };
    forged.sign = rsaSign(
      signContent(forged, ['sign', 'sign_type']),
      app.keyObj
    );
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

  it('部署自检：推出应用公钥指纹，识别签名被拒与支付宝公钥填错', async () => {
    assert.strictEqual(appPublicKeyOf(cfg), app.pub);
    assert.strictEqual(
      keyFingerprint(app.pub),
      keyFingerprint(app.pubPem.replace(/-----[^-]+-----/g, ''))
    );
    const reply =
      (node: string, signer = ali.keyObj): any =>
      async () => ({
        text: async () =>
          `{"alipay_trade_query_response":${node},"sign":"${rsaSign(
            node,
            signer
          )}"}`,
      });
    const notExist =
      '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"交易不存在"}';
    const ok = await selfCheck(cfg, reply(notExist));
    assert.strictEqual(ok.subCode, 'ACQ.TRADE_NOT_EXIST');
    assert.strictEqual(ok.signatureAccepted, true);
    assert.strictEqual(ok.responseVerified, true);
    assert.ok(!JSON.stringify(ok).includes(app.priv8.slice(40, 80)));

    const badSign =
      '{"code":"40002","msg":"Invalid Arguments","sub_code":"isv.invalid-signature","sub_msg":"验签出错"}';
    assert.strictEqual(
      (await selfCheck(cfg, reply(badSign))).signatureAccepted,
      false
    );
    // 支付宝公钥填成了别的（这里用应用私钥冒充支付宝签名）
    assert.strictEqual(
      (await selfCheck(cfg, reply(notExist, app.keyObj))).responseVerified,
      false
    );
    const down: any = async () => {
      throw new Error('ECONNRESET');
    };
    assert.match((await selfCheck(cfg, down)).error!, /ECONNRESET/);
  });

  it('管理员可下 1 分钱测试单（免费期也可），普通用户不行', async () => {
    const created: any[] = [];
    const { rt } = fakeRuntime({});
    rt.billing.activate = async () => ({ created: false });
    rt.billing.createOrder = async (uid: string, sku: any, cents: number) => {
      const o = {
        order_no: 'MJTEST1',
        user_id: uid,
        sku: sku.sku,
        amount_cents: cents,
        status: 'pending',
      };
      created.push(o);
      return o;
    };
    rt.userIdOf = async () => 'u1';
    const call = async (admin: boolean) => {
      rt.isAdmin = async () => admin;
      const res = fakeRes();
      await handleSelfServe(
        { headers: {} } as any,
        res,
        new URL('http://x/mcp/me/orders/alipay/test'),
        rt,
        Buffer.from('{}'),
        'POST'
      );
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    assert.strictEqual((await call(false)).status, 403);
    assert.strictEqual(created.length, 0);
    const ok = await call(true);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.data.amount, 0.01);
    assert.strictEqual(ok.body.data.name, '支付宝收款测试');
    const biz = JSON.parse(
      new URL(ok.body.data.alipayUrl).searchParams.get('biz_content')!
    );
    assert.strictEqual(biz.total_amount, '0.01');
    assert.strictEqual(biz.out_trade_no, 'MJTEST1');
  });

  it('超过单笔限额的订单不给支付宝链接，取链接接口说明改走微信', async () => {
    assert.strictEqual(cfg.maxCents, 5000);
    assert.strictEqual(
      loadAlipayConfig({
        ALIPAY_APP_ID: '2021000000000001',
        ALIPAY_PRIVATE_KEY: app.priv8,
        ALIPAY_PUBLIC_KEY: ali.pub,
        ALIPAY_MAX_CENTS: '0',
      })!.maxCents,
      0
    );
    assert.strictEqual(pricing(new Date(), true, 5000).alipayMaxYuan, 50);
    assert.strictEqual(pricing(new Date(), true, 0).alipayMaxYuan, null);
    assert.strictEqual(pricing(new Date(), false, 5000).alipayMaxYuan, null);

    const orders: Record<string, any> = {
      MJY: {
        order_no: 'MJY',
        user_id: 'u1',
        sku: 'member_year',
        amount_cents: 11950,
        status: 'pending',
      },
      MJM: {
        order_no: 'MJM',
        user_id: 'u1',
        sku: 'member_month',
        amount_cents: 1450,
        status: 'pending',
      },
    };
    const { rt } = fakeRuntime(orders);
    rt.userIdOf = async () => 'u1';
    const call = async (orderNo: string) => {
      const res = fakeRes();
      await handleSelfServe(
        { headers: {} } as any,
        res,
        new URL('http://x/mcp/me/orders/alipay'),
        rt,
        Buffer.from(JSON.stringify({ orderNo })),
        'POST'
      );
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    const year = await call('MJY');
    assert.strictEqual(year.status, 400);
    assert.match(year.body.message, /超过支付宝单笔限额 ¥50/);
    assert.match(year.body.message, /微信/);
    const month = await call('MJM');
    assert.strictEqual(month.status, 200);
    assert.ok(month.body.data.alipayUrl.includes('alipay.trade.page.pay'));
    // 提额后把限额调成 0（不限），年卡也能走支付宝
    rt.alipay = { ...cfg, maxCents: 0 };
    assert.strictEqual((await call('MJY')).status, 200);
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
