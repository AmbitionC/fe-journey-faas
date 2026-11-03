/**
 * 收款提醒（2026-11-03 owner：「收到付费后，短信提醒我一下」）。
 *
 * 两站共用的会员 / 加油包订单在两个时刻提醒站长：
 *   paid      支付宝确认到账并已发货（真金白银到账）；
 *   reported  用户微信扫码后点了「我已支付」（钱是否到账要站长去微信里核对再确认）。
 * 管理员在后台手动确认的那一下不再提醒（站长自己点的）。
 *
 * 通道（都是可选的，缺配置就跳过，**任何失败都不抛错、不影响订单与发货**）：
 *   短信  阿里云短信服务 SendSms：PAY_NOTIFY_SMS_SIGN + PAY_NOTIFY_SMS_TEMPLATE
 *         （模板变量 item / amount / via），AccessKey 复用 SMS_ACCESS_KEY_*（需 dysms:SendSms 权限）；
 *         收信号码＝user 表里 role=admin 的手机号（PAY_NOTIFY_PHONES 可覆盖，逗号分隔）。
 *         注意：登录用的「号码认证·短信认证」只能发验证码，发不了通知，所以要单独的短信服务签名与模板。
 *   邮件  阿里云邮件推送 SMTP（与预警邮件同一发信地址）：DM_SMTP_USER / DM_SMTP_PASS
 *         [DM_SMTP_HOST 默认 smtpdm.aliyun.com:465]，收件人 PAY_NOTIFY_EMAIL（缺省 ALERT_SELFTEST_TO）。
 *
 * 测试单照发但标【测试】：1 分钱收款测试 SKU、管理员自己下的单、PAY_NOTIFY_TEST_PHONES
 * （默认 19900001101）里的测试账号。
 */
import { callRpc } from '../common/aliyunRpc';

export type PayEventKind = 'paid' | 'reported';

export interface PayEvent {
  kind: PayEventKind;
  orderNo: string;
  sku: string;
  skuName: string;
  amountCents: number;
  userId: string | null;
  /** alipay | wechat */
  channel: 'alipay' | 'wechat';
}

type Query = (sql: string, params?: any[]) => Promise<any>;

export interface PayNotifyDeps {
  query: Query;
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string, init: any) => Promise<any>;
  /** 发邮件；单测注入。默认 nodemailer + SMTP */
  sendMail?: (m: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<void>;
  now?: () => Date;
}

export interface NotifyResult {
  sms: 'sent' | 'unconfigured' | 'failed' | 'no_phone';
  mail: 'sent' | 'unconfigured' | 'failed';
  test: boolean;
  detail?: string[];
}

const DEFAULT_TEST_PHONES = ['19900001101'];

export function maskPhone(p?: string | null): string {
  const s = String(p || '').replace(/\D/g, '');
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s || '未知';
}

export function yuan(cents: number): string {
  const v = Number(cents) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function bjClock(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600 * 1000).toISOString();
  return `${t.slice(5, 10)} ${t.slice(11, 16)}`;
}

export function listEnv(v: string | undefined, dflt: string[] = []): string[] {
  if (v === undefined) return dflt;
  return v
    .split(/[,，\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

export interface Rendered {
  test: boolean;
  /** 短信模板变量（长度按通知类模板变量上限控制） */
  smsParams: { item: string; amount: string; via: string };
  subject: string;
  text: string;
}

export function render(
  ev: PayEvent,
  buyer: { phone: string | null; role: string | null },
  testPhones: string[],
  now: Date
): Rendered {
  const test =
    ev.sku === 'pay_test' ||
    buyer.role === 'admin' ||
    (!!buyer.phone && testPhones.includes(buyer.phone));
  const tag = test ? '【测试】' : '';
  const via =
    ev.kind === 'paid'
      ? ev.channel === 'alipay'
        ? '支付宝已到账'
        : '已到账'
      : '微信待核对';
  const amount = yuan(ev.amountCents);
  const who = maskPhone(buyer.phone);
  const subject =
    ev.kind === 'paid'
      ? `${tag}收到付款 ¥${amount} · ${ev.skuName}`
      : `${tag}待核对：用户称已微信付款 ¥${amount} · ${ev.skuName}`;
  const lines = [
    ev.kind === 'paid'
      ? `支付宝已到账，点数/会员已自动发放。`
      : `用户点了「我已支付」（微信扫码）。请到微信收款记录核对备注，确认到账后在后台「开发者服务 > 订单」点确认发放。`,
    '',
    `商品：${ev.skuName}`,
    `金额：¥${amount}`,
    `用户：${who}`,
    `订单号：${ev.orderNo}`,
    `时间：${bjClock(now)}（北京时间）`,
  ];
  if (test)
    lines.push(
      '',
      '这是测试单（1 分钱测试 / 管理员或测试账号下单），不计入营收。'
    );
  return {
    test,
    smsParams: { item: `${tag}${ev.skuName}`.slice(0, 35), amount, via },
    subject,
    text: lines.join('\n'),
  };
}

async function defaultSendMail(
  env: Record<string, string | undefined>,
  m: { to: string; subject: string; text: string }
) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require('nodemailer');
  const host = env.DM_SMTP_HOST || env.SMTP_HOST || 'smtpdm.aliyun.com';
  const port = Number(env.DM_SMTP_PORT || env.SMTP_PORT || 465);
  const user = env.DM_SMTP_USER || env.SMTP_USER;
  const t = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass: env.DM_SMTP_PASS || env.SMTP_PASS },
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 6000,
  });
  await t.sendMail({
    from: `"收款提醒" <${user}>`,
    to: m.to,
    subject: m.subject,
    text: m.text,
  });
}

export class PayNotifier {
  private env: Record<string, string | undefined>;
  constructor(private deps: PayNotifyDeps) {
    this.env = deps.env || process.env;
  }

  private async buyer(userId: string | null) {
    if (!userId) return { phone: null, role: null };
    try {
      const rows = await this.deps.query(
        'SELECT phoneNumber, role FROM `user` WHERE id = ? LIMIT 1',
        [userId]
      );
      const r = Array.isArray(rows) ? rows[0] : null;
      return {
        phone: r?.phoneNumber ? String(r.phoneNumber) : null,
        role: r?.role || null,
      };
    } catch {
      return { phone: null, role: null };
    }
  }

  private async adminPhones(): Promise<string[]> {
    const fixed = listEnv(this.env.PAY_NOTIFY_PHONES);
    if (fixed.length) return fixed;
    try {
      const rows = await this.deps.query(
        "SELECT phoneNumber FROM `user` WHERE role = 'admin' AND phoneNumber <> '' ORDER BY id LIMIT 5"
      );
      return (Array.isArray(rows) ? rows : [])
        .map((r: any) => String(r.phoneNumber || '').trim())
        .filter(p => /^1\d{10}$/.test(p));
    } catch {
      return [];
    }
  }

  async notify(ev: PayEvent): Promise<NotifyResult> {
    const now = (this.deps.now || (() => new Date()))();
    const detail: string[] = [];
    const b = await this.buyer(ev.userId);
    const r = render(
      ev,
      b,
      listEnv(this.env.PAY_NOTIFY_TEST_PHONES, DEFAULT_TEST_PHONES),
      now
    );
    const [sms, mail] = await Promise.all([
      this.sms(r, detail),
      this.mail(r, detail),
    ]);
    return { sms, mail, test: r.test, detail };
  }

  private async sms(
    r: Rendered,
    detail: string[]
  ): Promise<NotifyResult['sms']> {
    const e = this.env;
    const sign = (e.PAY_NOTIFY_SMS_SIGN || '').trim();
    const tpl = (e.PAY_NOTIFY_SMS_TEMPLATE || '').trim();
    const ak = (e.SMS_ACCESS_KEY_ID || '').trim();
    const sk = (e.SMS_ACCESS_KEY_SECRET || '').trim();
    if (!sign || !tpl || !ak || !sk) return 'unconfigured';
    const phones = await this.adminPhones();
    if (!phones.length) return 'no_phone';
    try {
      const res = await callRpc({
        endpoint: 'https://dysmsapi.aliyuncs.com/',
        action: 'SendSms',
        version: '2017-05-25',
        accessKeyId: ak,
        accessKeySecret: sk,
        params: {
          PhoneNumbers: phones.join(','),
          SignName: sign,
          TemplateCode: tpl,
          TemplateParam: JSON.stringify(r.smsParams),
        },
        fetchImpl: this.deps.fetchImpl,
        timeoutMs: 4000,
      });
      if (res?.Code === 'OK') return 'sent';
      detail.push(`sms ${res?.Code}: ${res?.Message}`);
      return 'failed';
    } catch (err: any) {
      detail.push(`sms ${err?.message || err}`);
      return 'failed';
    }
  }

  private async mail(
    r: Rendered,
    detail: string[]
  ): Promise<NotifyResult['mail']> {
    const e = this.env;
    const to = (e.PAY_NOTIFY_EMAIL || e.ALERT_SELFTEST_TO || '').trim();
    const user = e.DM_SMTP_USER || e.SMTP_USER;
    const pass = e.DM_SMTP_PASS || e.SMTP_PASS;
    if (!to || !user || !pass) return 'unconfigured';
    try {
      const send = this.deps.sendMail || (m => defaultSendMail(e, m));
      await send({ to, subject: r.subject, text: r.text });
      return 'sent';
    } catch (err: any) {
      detail.push(`mail ${err?.message || err}`);
      return 'failed';
    }
  }
}

/**
 * 订单路径上的调用口：最多等 timeoutMs（FC 返回响应后实例可能被冻结，纯 fire-and-forget 会丢），
 * 超时或出错一律吞掉，只打日志——订单与发货已经完成，提醒失败不能把它们带下去。
 */
export async function notifySafely(
  n: PayNotifier | null | undefined,
  ev: PayEvent,
  timeoutMs = 5000
): Promise<NotifyResult | null> {
  if (!n) return null;
  let timer: any;
  try {
    const r = await Promise.race([
      n.notify(ev),
      new Promise<null>(res => {
        timer = setTimeout(() => res(null), timeoutMs);
      }),
    ]);
    if (!r) console.warn('[pay-notify] 超时', ev.orderNo);
    else if (r.sms === 'failed' || r.mail === 'failed')
      console.warn('[pay-notify] 部分失败', ev.orderNo, r);
    return r;
  } catch (e: any) {
    console.warn('[pay-notify] 失败', ev.orderNo, e?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
