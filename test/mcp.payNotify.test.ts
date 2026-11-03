import * as assert from 'assert';
import { PayNotifier, notifySafely, render, PayEvent } from '../src/mcp/payNotify';

/** 收款提醒：短信 / 邮件两通道、测试单标注、任何失败都不抛到订单路径。 */

const ev = (over: Partial<PayEvent> = {}): PayEvent => ({
  kind: 'paid',
  channel: 'alipay',
  orderNo: 'MJ9',
  sku: 'member_month',
  skuName: '会员月卡',
  amountCents: 1450,
  userId: '42',
  ...over,
});

function fakeQuery(users: Record<string, { phoneNumber: string; role: string }>) {
  return async (sql: string, params: any[] = []) => {
    if (/role = 'admin'/.test(sql))
      return Object.values(users).filter(u => u.role === 'admin');
    if (/WHERE id = \?/.test(sql)) return users[params[0]] ? [users[params[0]]] : [];
    return [];
  };
}

const USERS = {
  '1': { phoneNumber: '17300000001', role: 'admin' },
  '42': { phoneNumber: '13812345678', role: 'user' },
  '77': { phoneNumber: '19900001101', role: 'user' },
};

const FULL_ENV = {
  SMS_ACCESS_KEY_ID: 'ak',
  SMS_ACCESS_KEY_SECRET: 'sk',
  PAY_NOTIFY_SMS_SIGN: '签名',
  PAY_NOTIFY_SMS_TEMPLATE: 'SMS_1',
  DM_SMTP_USER: 'alert@mail.example',
  DM_SMTP_PASS: 'p',
  ALERT_SELFTEST_TO: 'owner@example.com',
};

describe('收款提醒', () => {
  it('支付宝到账：短信发给管理员手机号，模板变量 item/amount/via；邮件发到站长邮箱', async () => {
    const calls: string[] = [];
    const mails: any[] = [];
    const n = new PayNotifier({
      query: fakeQuery(USERS),
      env: FULL_ENV,
      fetchImpl: async (url: string, init: any) => {
        calls.push(`${url}?${init.body}`);
        return { json: async () => ({ Code: 'OK' }), text: async () => '{"Code":"OK"}', ok: true, status: 200 };
      },
      sendMail: async m => {
        mails.push(m);
      },
    });
    const r = await n.notify(ev());
    assert.strictEqual(r.sms, 'sent');
    assert.strictEqual(r.mail, 'sent');
    assert.strictEqual(r.test, false);
    const u = new URL(calls[0]);
    assert.ok(u.hostname === 'dysmsapi.aliyuncs.com');
    assert.strictEqual(u.searchParams.get('PhoneNumbers'), '17300000001');
    assert.deepStrictEqual(JSON.parse(u.searchParams.get('TemplateParam')!), {
      item: '会员月卡',
      amount: '14.50',
      via: '支付宝已到账',
    });
    assert.strictEqual(mails[0].to, 'owner@example.com');
    assert.match(mails[0].subject, /收到付款 ¥14\.50 · 会员月卡/);
    // 邮件里买家号码打码
    assert.match(mails[0].text, /138\*\*\*\*5678/);
    assert.doesNotMatch(mails[0].text, /13812345678/);
  });

  it('1 分钱测试单、管理员自己下的单、测试账号都标【测试】', () => {
    const now = new Date('2026-11-03T08:00:00Z');
    assert.ok(render(ev({ sku: 'pay_test' }), { phone: '13812345678', role: 'user' }, [], now).test);
    assert.ok(render(ev(), { phone: '17300000001', role: 'admin' }, [], now).test);
    const t = render(ev(), { phone: '19900001101', role: 'user' }, ['19900001101'], now);
    assert.ok(t.test);
    assert.match(t.subject, /^【测试】/);
    assert.match(t.smsParams.item, /^【测试】/);
    assert.ok(!render(ev(), { phone: '13812345678', role: 'user' }, ['19900001101'], now).test);
  });

  it('微信自报：提示待核对', () => {
    const r = render(ev({ kind: 'reported', channel: 'wechat' }), { phone: null, role: null }, [], new Date());
    assert.strictEqual(r.smsParams.via, '微信待核对');
    assert.match(r.subject, /待核对/);
  });

  it('缺配置时跳过，不发请求', async () => {
    let fetched = 0;
    const n = new PayNotifier({
      query: fakeQuery(USERS),
      env: {},
      fetchImpl: async () => {
        fetched++;
        return {};
      },
    });
    const r = await n.notify(ev());
    assert.deepStrictEqual([r.sms, r.mail], ['unconfigured', 'unconfigured']);
    assert.strictEqual(fetched, 0);
  });

  it('短信网关报错、邮件抛错、数据库抛错都不外抛', async () => {
    const n = new PayNotifier({
      query: async () => {
        throw new Error('db down');
      },
      env: { ...FULL_ENV, PAY_NOTIFY_PHONES: '17300000001' },
      fetchImpl: async () => ({
        json: async () => ({ Code: 'isv.SMS_SIGNATURE_ILLEGAL', Message: 'x' }),
        text: async () => '{"Code":"isv.SMS_SIGNATURE_ILLEGAL","Message":"x"}',
        ok: true,
        status: 200,
      }),
      sendMail: async () => {
        throw new Error('smtp down');
      },
    });
    const r = await notifySafely(n, ev());
    assert.strictEqual(r!.sms, 'failed');
    assert.strictEqual(r!.mail, 'failed');
  });

  it('通道卡住时最多等 timeoutMs 就放行', async () => {
    const n: any = { notify: () => new Promise(() => {}) };
    const t0 = Date.now();
    const r = await notifySafely(n, ev(), 50);
    assert.strictEqual(r, null);
    assert.ok(Date.now() - t0 < 1000);
  });
});
