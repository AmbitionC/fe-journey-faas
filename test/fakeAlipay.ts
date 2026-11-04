import { generateKeyPairSync } from 'crypto';
import { loadAlipayConfig, rsaSign, signContent } from '../src/mcp/alipay';

/**
 * 测试用的支付宝：本地两对密钥分别扮演「我们的应用」和「支付宝」。
 * 微信收款关闭后（2026-11-04）下单必须开通支付宝，下单类测试的假运行时都挂这一份。
 */
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const strip = (s: string) => s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return {
    priv8: strip(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    pub: strip(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    keyObj: privateKey,
  };
}

const app = keyPair();
const ali = keyPair();

export const fakeAlipayCfg = loadAlipayConfig({
  ALIPAY_APP_ID: '2021000000000001',
  ALIPAY_PRIVATE_KEY: app.priv8,
  ALIPAY_PUBLIC_KEY: ali.pub,
  ALIPAY_NOTIFY_URL: 'https://fc.example/mcp/pay/alipay/notify',
})!;

/** 以「支付宝」的私钥签一条到账通知，返回 form-urlencoded 请求体。 */
export function fakeAlipayPaid(orderNo: string, amountCents: number, tradeNo = 'T' + orderNo): Buffer {
  const p: Record<string, string> = {
    app_id: fakeAlipayCfg.appId,
    charset: 'utf-8',
    sign_type: 'RSA2',
    notify_type: 'trade_status_sync',
    out_trade_no: orderNo,
    total_amount: (amountCents / 100).toFixed(2),
    trade_status: 'TRADE_SUCCESS',
    trade_no: tradeNo,
  };
  p.sign = rsaSign(signContent(p, ['sign', 'sign_type']), ali.keyObj);
  return Buffer.from(new URLSearchParams(p).toString());
}
