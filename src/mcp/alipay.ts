import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  createPrivateKey,
  KeyObject,
} from 'crypto';
import fetch from 'node-fetch';

/**
 * 支付宝「AI 网页应用收款」（Vibe Pay 基础收款能力，即 alipay.trade.page.pay 电脑/手机网站支付）。
 *
 * 只做三件事：生成付款跳转链接、验签异步通知、主动查单。发货仍走 BillingStore.fulfill（幂等），
 * 所以通知重复推送、查单与通知同时到达都不会重复发点。
 *
 * 不引 SDK：签名就是「按 key 排序拼 k=v&k=v → RSA-SHA256 → base64」，Node 自带 crypto 足够。
 * 文档：https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/ai-web-app-payment-integration-guide.md
 *
 * 环境变量（缺 APP_ID / 私钥 / 支付宝公钥任一项即视为未开通，前端只显示微信收款码）：
 * - ALIPAY_APP_ID
 * - ALIPAY_PRIVATE_KEY      应用私钥（PKCS#8 或 PKCS#1，可带或不带 PEM 头尾）
 * - ALIPAY_PUBLIC_KEY       支付宝公钥（不是应用公钥）
 * - ALIPAY_GATEWAY          默认正式网关；沙箱填 https://openapi-sandbox.dl.alipaydev.com/gateway.do
 * - ALIPAY_NOTIFY_URL       异步通知地址（须外网可达，指向本服务 /mcp/pay/alipay/notify）
 * - ALIPAY_RETURN_URL       付完跳回的页面（默认官网 /developer）
 */

export const DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway.do';

export interface AlipayConfig {
  appId: string;
  privateKey: KeyObject;
  alipayPublicKey: string;
  gateway: string;
  notifyUrl: string;
  returnUrl: string;
}

function pem(body: string, label: string): string {
  const b = body.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return `-----BEGIN ${label}-----\n${b
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END ${label}-----\n`;
}

/** 私钥兼容支付宝密钥工具导出的两种格式（Java 默认 PKCS#8，其余语言常用 PKCS#1）。 */
export function loadPrivateKey(raw: string): KeyObject {
  if (/-----BEGIN/.test(raw)) return createPrivateKey(raw);
  try {
    return createPrivateKey(pem(raw, 'PRIVATE KEY'));
  } catch {
    return createPrivateKey(pem(raw, 'RSA PRIVATE KEY'));
  }
}

export function loadAlipayConfig(
  env: Record<string, string | undefined> = process.env
): AlipayConfig | null {
  const appId = (env.ALIPAY_APP_ID || '').trim();
  const priv = (env.ALIPAY_PRIVATE_KEY || '').trim();
  const pub = (env.ALIPAY_PUBLIC_KEY || '').trim();
  if (!appId || !priv || !pub) return null;
  return {
    appId,
    privateKey: loadPrivateKey(priv),
    alipayPublicKey: /-----BEGIN/.test(pub) ? pub : pem(pub, 'PUBLIC KEY'),
    gateway: (env.ALIPAY_GATEWAY || '').trim() || DEFAULT_GATEWAY,
    notifyUrl: (env.ALIPAY_NOTIFY_URL || '').trim(),
    returnUrl:
      (env.ALIPAY_RETURN_URL || '').trim() ||
      'https://www.agent-journey.cn/developer',
  };
}

/** 待签名串：去掉 sign（通知验签时还去掉 sign_type）与空值，按 key 升序拼接。 */
export function signContent(
  params: Record<string, any>,
  omit: string[] = ['sign']
): string {
  return Object.keys(params)
    .filter(
      k =>
        !omit.includes(k) &&
        params[k] !== undefined &&
        params[k] !== null &&
        params[k] !== ''
    )
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

export function rsaSign(content: string, key: KeyObject): string {
  return createSign('RSA-SHA256').update(content, 'utf8').sign(key, 'base64');
}

export function rsaVerify(
  content: string,
  sign: string,
  publicKeyPem: string
): boolean {
  try {
    return createVerify('RSA-SHA256')
      .update(content, 'utf8')
      .verify(publicKeyPem, sign, 'base64');
  } catch {
    return false;
  }
}

/** 支付宝要求的北京时间 yyyy-MM-dd HH:mm:ss。 */
export function bjTime(d: Date): string {
  return new Date(d.getTime() + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function commonParams(cfg: AlipayConfig, method: string, now: Date) {
  return {
    app_id: cfg.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: bjTime(now),
    version: '1.0',
  } as Record<string, string>;
}

export interface PayOrder {
  orderNo: string;
  amountCents: number;
  subject: string;
}

/**
 * 生成付款链接（GET 跳转即可进入支付宝收银台，电脑扫码与手机浏览器都支持）。
 * 纯本地签名、不走网络，所以每次下单都可以直接带上；前端点按钮时再取一次新签的链接。
 * 不设 time_expire：未付款订单会被下单接口复用，同一 out_trade_no 的支付宝交易一旦超时关闭就不能再付，
 * 走支付宝默认的超时（较长）更稳。
 */
export function pagePayUrl(
  cfg: AlipayConfig,
  o: PayOrder,
  now = new Date()
): string {
  const params: Record<string, string> = {
    ...commonParams(cfg, 'alipay.trade.page.pay', now),
    return_url: cfg.returnUrl,
    biz_content: JSON.stringify({
      out_trade_no: o.orderNo,
      total_amount: (o.amountCents / 100).toFixed(2),
      subject: o.subject.replace(/[/=&]/g, ' ').slice(0, 128),
      product_code: 'FAST_INSTANT_TRADE_PAY',
    }),
  };
  if (cfg.notifyUrl) params.notify_url = cfg.notifyUrl;
  params.sign = rsaSign(signContent(params), cfg.privateKey);
  return `${cfg.gateway}?${new URLSearchParams(params).toString()}`;
}

/** 异步通知验签：sign 与 sign_type 都不参与签名。 */
export function verifyNotify(
  cfg: AlipayConfig,
  params: Record<string, string>
): boolean {
  if (!params.sign) return false;
  return rsaVerify(
    signContent(params, ['sign', 'sign_type']),
    params.sign,
    cfg.alipayPublicKey
  );
}

/** ok 时 tradeNo 为支付宝交易号；否则 reason 说明为何不能发货。 */
export interface PaidCheck {
  ok: boolean;
  tradeNo?: string;
  reason?: string;
}

/**
 * 判断一条支付结果能否发货：交易成功、收款应用是我们、金额与订单一致。
 * 通知与主动查单共用，免得两条路判据不一致。
 */
export function checkPaid(
  cfg: AlipayConfig,
  r: Record<string, any>,
  order: { order_no: string; amount_cents: number } | null
): PaidCheck {
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (r.app_id && r.app_id !== cfg.appId)
    return { ok: false, reason: 'app_id_mismatch' };
  if (r.out_trade_no !== order.order_no)
    return { ok: false, reason: 'order_no_mismatch' };
  if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(r.trade_status))
    return { ok: false, reason: `status_${r.trade_status || 'unknown'}` };
  const paid = Math.round(Number(r.total_amount) * 100);
  if (paid !== Number(order.amount_cents))
    return { ok: false, reason: 'amount_mismatch' };
  return { ok: true, tradeNo: String(r.trade_no || '') };
}

/**
 * 从网关响应原文里截出 *_response 节点的原始 JSON 串（验签必须用原文，不能 JSON.stringify 回去）。
 */
export function extractResponseNode(raw: string, node: string): string | null {
  const key = `"${node}"`;
  let i = raw.indexOf(key);
  if (i < 0) return null;
  i = raw.indexOf('{', i + key.length);
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return raw.slice(i, j + 1);
  }
  return null;
}

async function postQuery(
  cfg: AlipayConfig,
  orderNo: string,
  doFetch: typeof fetch
): Promise<string> {
  const params: Record<string, string> = {
    ...commonParams(cfg, 'alipay.trade.query', new Date()),
    biz_content: JSON.stringify({ out_trade_no: orderNo }),
  };
  params.sign = rsaSign(signContent(params), cfg.privateKey);
  const resp = await doFetch(cfg.gateway, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: new URLSearchParams(params).toString(),
    timeout: 10000,
  } as any);
  return resp.text();
}

/** 由应用私钥推出的应用公钥（SPKI，base64，非机密），用于核对填进去的私钥与支付宝登记的公钥是否同一对。 */
export function appPublicKeyOf(cfg: AlipayConfig): string {
  return createPublicKey(cfg.privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
}

export function keyFingerprint(spkiBase64: string): string {
  return createHash('sha256')
    .update(Buffer.from(spkiBase64.replace(/\s+/g, ''), 'base64'))
    .digest('hex')
    .slice(0, 16);
}

export interface SelfCheck {
  appId: string;
  gateway: string;
  appPublicKeySha256: string;
  /** 支付宝对「查一笔不存在的订单」的回答：签名对时应为 40004 / ACQ.TRADE_NOT_EXIST。 */
  code?: string;
  subCode?: string;
  subMsg?: string;
  /** 响应带签名且能用 ALIPAY_PUBLIC_KEY 验过＝支付宝公钥填对了。 */
  responseVerified?: boolean;
  /** 应用私钥能被支付宝认出（签名没被拒）。 */
  signatureAccepted?: boolean;
  error?: string;
}

/**
 * 部署后自检：用真实配置查一笔不存在的订单。
 * 只产出非机密事实（APPID、应用公钥指纹、支付宝返回码），不打印任何私钥材料。
 */
export async function selfCheck(
  cfg: AlipayConfig,
  doFetch: typeof fetch = fetch
): Promise<SelfCheck> {
  const out: SelfCheck = {
    appId: cfg.appId,
    gateway: cfg.gateway,
    appPublicKeySha256: keyFingerprint(appPublicKeyOf(cfg)),
  };
  try {
    const raw = await postQuery(cfg, `SELFCHECK${Date.now()}`, doFetch);
    const node = extractResponseNode(raw, 'alipay_trade_query_response');
    if (!node) throw new Error('响应无法解析');
    const r = JSON.parse(node);
    const sign = JSON.parse(raw).sign;
    out.code = r.code;
    out.subCode = r.sub_code;
    out.subMsg = r.sub_msg;
    out.responseVerified = !!sign && rsaVerify(node, sign, cfg.alipayPublicKey);
    out.signatureAccepted = !/invalid-signature|invalid-app-?id/i.test(
      String(r.sub_code || '')
    );
  } catch (e: any) {
    out.error = String(e?.message || e);
  }
  return out;
}

/** 主动查单（用户付完跳回、或通知没到时补查）。返回已验签的 alipay_trade_query_response。 */
export async function queryTrade(
  cfg: AlipayConfig,
  orderNo: string,
  doFetch: typeof fetch = fetch
): Promise<Record<string, any>> {
  const raw = await postQuery(cfg, orderNo, doFetch);
  const node = extractResponseNode(raw, 'alipay_trade_query_response');
  if (!node) throw new Error('支付宝查单响应无法解析');
  const parsed = JSON.parse(raw);
  const r = JSON.parse(node);
  // 失败响应（code≠10000）可能不带签名；成功响应必须验签通过才采信
  if (r.code === '10000') {
    if (!parsed.sign || !rsaVerify(node, parsed.sign, cfg.alipayPublicKey))
      throw new Error('支付宝查单响应验签失败');
  }
  return r;
}
