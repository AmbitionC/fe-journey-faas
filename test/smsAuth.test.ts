import * as assert from 'assert';
import { callRpc, percentEncode, signRpc } from '../src/common/aliyunRpc';
import {
  SmsAuthService,
  SMS_LIMITS,
  sendErrorMessage,
} from '../src/service/auth/sms';
import { AuthHTTPService, autoNickName } from '../src/function/auth';

/**
 * 短信验证码（阿里云号码认证·短信认证，2026-10-27）。
 *
 * 不碰真实阿里云：HTTP 调用经 fetchImpl 替身记录参数并返回预设 JSON；Redis 用内存替身。
 * 重点验三件事：签名算法与官方样例逐字一致、防刷配额真能拦住、验证码一码一用。
 */

function fakeRedis(opts: { broken?: boolean } = {}) {
  const kv: Record<string, string> = {};
  const ttl: Record<string, number> = {};
  const guard = () => {
    if (opts.broken) throw new Error('redis down');
  };
  return {
    kv,
    ttl,
    async get(k: string) {
      guard();
      return k in kv ? kv[k] : null;
    },
    async set(k: string, v: string, ...args: any[]) {
      guard();
      if (args.includes('NX') && k in kv) return null;
      kv[k] = v;
      const i = args.indexOf('EX');
      if (i >= 0) ttl[k] = args[i + 1];
      return 'OK';
    },
    async del(...keys: string[]) {
      guard();
      let n = 0;
      for (const k of keys) if (k in kv) delete kv[k], n++;
      return n;
    },
    async incr(k: string) {
      guard();
      kv[k] = String(Number(kv[k] || 0) + 1);
      return Number(kv[k]);
    },
    async expire(k: string, s: number) {
      guard();
      ttl[k] = s;
      return 1;
    },
  };
}

/** 阿里云替身：记录每次调用的表单参数，按 Action 返回预设结果。 */
function fakeAliyun(reply: Record<string, any> = {}) {
  const calls: Record<string, string>[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(init.body)) params[k] = v;
    calls.push(params);
    const body = reply[params.Action] ?? {
      Code: 'OK',
      Success: true,
      Model: {},
    };
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

const ENV_KEYS = [
  'SMS_ACCESS_KEY_ID',
  'SMS_ACCESS_KEY_SECRET',
  'SMS_SIGN_NAME',
  'SMS_DAILY_CAP',
];
let savedEnv: Record<string, string | undefined> = {};

function enableSms(extra: Record<string, string> = {}) {
  process.env.SMS_ACCESS_KEY_ID = 'test-id';
  process.env.SMS_ACCESS_KEY_SECRET = 'test-secret';
  process.env.SMS_SIGN_NAME = '测试签名';
  Object.assign(process.env, extra);
}

function makeSms(redis: any, aliyun = fakeAliyun()): any {
  const svc: any = new SmsAuthService();
  svc.redisService = redis;
  svc.logger = { warn() {}, info() {} };
  svc.fetchImpl = aliyun.fetchImpl;
  return svc;
}

async function rejection(p: Promise<any>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e: any) {
    return e?.message || String(e);
  }
}

describe('短信验证码（号码认证·短信认证）', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  describe('阿里云 RPC 签名（V1 / HMAC-SHA1）', () => {
    it('与阿里云签名文档的官方样例逐字一致', () => {
      const sig = signRpc(
        'GET',
        {
          AccessKeyId: 'testid',
          Action: 'DescribeRegions',
          Format: 'XML',
          SignatureMethod: 'HMAC-SHA1',
          SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
          SignatureVersion: '1.0',
          Timestamp: '2016-02-23T12:46:24Z',
          Version: '2014-05-26',
        },
        'testsecret'
      );
      assert.strictEqual(sig, 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=');
    });

    it('百分号编码：空格→%20、*→%2A、~ 保留、中文按 UTF-8', () => {
      assert.strictEqual(percentEncode('a b*~'), 'a%20b%2A~');
      assert.strictEqual(percentEncode("!'()"), '%21%27%28%29');
      assert.strictEqual(percentEncode('签'), '%E7%AD%BE');
    });

    it('请求体带上公共参数与签名，且签名可由同一组参数复算', async () => {
      const aliyun = fakeAliyun({ Ping: { Code: 'OK' } });
      const res = await callRpc({
        endpoint: 'https://example.invalid/',
        action: 'Ping',
        version: '2017-05-25',
        accessKeyId: 'id',
        accessKeySecret: 'secret',
        params: { PhoneNumber: '13800000000', Empty: '' },
        fetchImpl: aliyun.fetchImpl,
      });
      assert.deepStrictEqual(res, { Code: 'OK' });
      const sent = { ...aliyun.calls[0] };
      assert.strictEqual(sent.Format, 'JSON');
      assert.strictEqual(sent.Version, '2017-05-25');
      assert.ok(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(sent.Timestamp),
        sent.Timestamp
      );
      assert.ok(!('Empty' in sent), '空参数不应发出');
      const { Signature, ...rest } = sent;
      assert.strictEqual(Signature, signRpc('POST', rest, 'secret'));
    });

    it('非 JSON 响应（如网关 502 页）不抛异常，转成可读错误码', async () => {
      const res = await callRpc({
        endpoint: 'https://example.invalid/',
        action: 'X',
        version: 'v',
        accessKeyId: 'id',
        accessKeySecret: 's',
        params: {},
        fetchImpl: async () => ({
          status: 502,
          text: async () => '<html>bad gateway</html>',
        }),
      });
      assert.strictEqual(res.Code, 'HTTP_502');
    });
  });

  describe('短信配置开关', () => {
    it('三项缺任一＝未开通', () => {
      const svc = makeSms(fakeRedis());
      assert.strictEqual(svc.enabled(), false);
      process.env.SMS_ACCESS_KEY_ID = 'a';
      process.env.SMS_ACCESS_KEY_SECRET = 'b';
      assert.strictEqual(svc.enabled(), false);
      process.env.SMS_SIGN_NAME = 'c';
      assert.strictEqual(svc.enabled(), true);
    });

    it('未开通时发送直接拒绝，不调阿里云', async () => {
      const aliyun = fakeAliyun();
      const svc = makeSms(fakeRedis(), aliyun);
      assert.match(
        (await rejection(svc.send('13800000000', 'login', '1.1.1.1'))) || '',
        /暂未开通/
      );
      assert.strictEqual(aliyun.calls.length, 0);
    });
  });

  describe('发送配额（防短信轰炸）', () => {
    beforeEach(() => enableSms());

    it('同号 60 秒冷却：第二次立刻发被拒', async () => {
      const svc = makeSms(fakeRedis());
      assert.strictEqual(
        await rejection(svc.send('13800000001', 'login', '1.1.1.1')),
        null
      );
      assert.match(
        (await rejection(svc.send('13800000001', 'login', '1.1.1.1'))) || '',
        /60 秒/
      );
    });

    it('同号每天最多 5 条（冷却过了也不行）', async () => {
      const redis = fakeRedis();
      const svc = makeSms(redis);
      for (let i = 1; i <= SMS_LIMITS.perPhoneDaily; i++) {
        delete redis.kv['sms:cd:13800000002']; // 模拟冷却已过
        assert.strictEqual(
          await rejection(svc.send('13800000002', 'login', `2.2.2.${i}`)),
          null,
          `第 ${i} 条`
        );
      }
      delete redis.kv['sms:cd:13800000002'];
      assert.match(
        (await rejection(svc.send('13800000002', 'login', '2.2.2.9'))) || '',
        /今天.*上限/
      );
    });

    it('同 IP 每小时最多 10 条（换号也不行）', async () => {
      const svc = makeSms(fakeRedis());
      for (let i = 0; i < SMS_LIMITS.perIpHourly; i++) {
        assert.strictEqual(
          await rejection(svc.send(`1390000000${i}`, 'login', '3.3.3.3')),
          null
        );
      }
      assert.match(
        (await rejection(svc.send('13911111111', 'login', '3.3.3.3'))) || '',
        /太频繁/
      );
    });

    it('全站每日封顶（SMS_DAILY_CAP）', async () => {
      enableSms({ SMS_DAILY_CAP: '3' });
      const aliyun = fakeAliyun();
      const svc = makeSms(fakeRedis(), aliyun);
      for (let i = 0; i < 3; i++) {
        assert.strictEqual(
          await rejection(svc.send(`1370000000${i}`, 'login', `4.4.4.${i}`)),
          null
        );
      }
      assert.match(
        (await rejection(svc.send('13711111111', 'login', '4.4.4.9'))) || '',
        /额度已用完/
      );
      assert.strictEqual(aliyun.calls.length, 3, '超额那条不应打到阿里云');
    });

    it('Redis 不可用时拒发（失败关闭），不调阿里云', async () => {
      const aliyun = fakeAliyun();
      const svc = makeSms(fakeRedis({ broken: true }), aliyun);
      assert.match(
        (await rejection(svc.send('13800000003', 'login', '1.1.1.1'))) || '',
        /暂不可用/
      );
      assert.strictEqual(aliyun.calls.length, 0);
    });
  });

  describe('发送参数与错误映射', () => {
    beforeEach(() => enableSms());

    it('按用途选模板，赠送模板的 code/min 变量与有效期一致', async () => {
      const aliyun = fakeAliyun();
      const svc = makeSms(fakeRedis(), aliyun);
      await svc.send('13800000004', 'login', '1.1.1.1');
      await svc.send('13800000005', 'reset', '1.1.1.2');
      const [a, b] = aliyun.calls;
      assert.strictEqual(a.Action, 'SendSmsVerifyCode');
      assert.strictEqual(a.TemplateCode, '100001');
      assert.strictEqual(b.TemplateCode, '100003');
      assert.strictEqual(a.SignName, '测试签名');
      assert.deepStrictEqual(JSON.parse(a.TemplateParam), {
        code: '##code##',
        min: '5',
      });
      assert.strictEqual(a.ValidTime, '300');
      assert.strictEqual(a.CodeLength, '6');
      assert.ok(
        !('ReturnVerifyCode' in a),
        '生产绝不让阿里云把验证码回传给服务端'
      );
    });

    it('阿里云号码日限流 → 人话提示', async () => {
      const svc = makeSms(
        fakeRedis(),
        fakeAliyun({
          SendSmsVerifyCode: { Code: 'BUSINESS_LIMIT_CONTROL', Message: 'x' },
        })
      );
      assert.match(
        (await rejection(svc.send('13800000006', 'login', '1.1.1.1'))) || '',
        /明天再试/
      );
      assert.strictEqual(
        sendErrorMessage('SignatureDoesNotMatch'),
        '短信发送失败，请稍后再试'
      );
      assert.match(sendErrorMessage('isv.BUSINESS_LIMIT_CONTROL'), /明天再试/);
      assert.match(sendErrorMessage('isv.FREQUENCY_FAIL'), /太频繁/);
    });
  });

  describe('核验（一码一用、防爆破、用途隔离）', () => {
    beforeEach(() => enableSms());

    it('通过后作废：同一个码第二次不认', async () => {
      const aliyun = fakeAliyun({
        CheckSmsVerifyCode: { Code: 'OK', Model: { VerifyResult: 'PASS' } },
      });
      const svc = makeSms(fakeRedis(), aliyun);
      await svc.send('13800000010', 'login', '1.1.1.1');
      assert.strictEqual(
        await svc.verify('13800000010', '123456', 'login'),
        true
      );
      assert.strictEqual(
        await svc.verify('13800000010', '123456', 'login'),
        false
      );
      assert.strictEqual(
        aliyun.calls.filter(c => c.Action === 'CheckSmsVerifyCode').length,
        1
      );
    });

    it('登录用的码不能拿去重置密码', async () => {
      const aliyun = fakeAliyun({
        CheckSmsVerifyCode: { Code: 'OK', Model: { VerifyResult: 'PASS' } },
      });
      const svc = makeSms(fakeRedis(), aliyun);
      await svc.send('13800000011', 'login', '1.1.1.1');
      assert.strictEqual(
        await svc.verify('13800000011', '123456', 'reset'),
        false
      );
      assert.strictEqual(
        aliyun.calls.filter(c => c.Action === 'CheckSmsVerifyCode').length,
        0
      );
    });

    it('没发过码直接核：不调阿里云', async () => {
      const aliyun = fakeAliyun();
      const svc = makeSms(fakeRedis(), aliyun);
      assert.strictEqual(
        await svc.verify('13800000012', '123456', 'login'),
        false
      );
      assert.strictEqual(aliyun.calls.length, 0);
    });

    it('错 5 次后第 6 次直接要求重发', async () => {
      const aliyun = fakeAliyun({
        CheckSmsVerifyCode: { Code: 'OK', Model: { VerifyResult: 'UNKNOWN' } },
      });
      const svc = makeSms(fakeRedis(), aliyun);
      await svc.send('13800000013', 'login', '1.1.1.1');
      for (let i = 0; i < SMS_LIMITS.maxTries; i++) {
        assert.strictEqual(
          await svc.verify('13800000013', '000000', 'login'),
          false
        );
      }
      assert.match(
        (await rejection(svc.verify('13800000013', '000000', 'login'))) || '',
        /次数过多/
      );
      // 之后即便猜对也不认（码已作废）
      assert.strictEqual(
        await svc.verify('13800000013', '123456', 'login'),
        false
      );
    });

    it('码错时阿里云回业务码 isv.ValidateFail（2026-10-27 线上自检实测）：判「不通过」而不是系统故障', async () => {
      const aliyun = fakeAliyun({
        CheckSmsVerifyCode: { Code: 'isv.ValidateFail', Message: '验证失败' },
      });
      const svc = makeSms(fakeRedis(), aliyun);
      await svc.send('13800000015', 'login', '1.1.1.1');
      assert.strictEqual(
        await svc.verify('13800000015', '000000', 'login'),
        false
      );
      // 一次输错不作废：同一条短信里的码还能再试（直到 5 次上限）
      assert.strictEqual(
        await svc.verify('13800000015', '000001', 'login'),
        false
      );
      assert.strictEqual(
        aliyun.calls.filter(c => c.Action === 'CheckSmsVerifyCode').length,
        2
      );
    });

    it('核验遇到鉴权类错误（密钥/权限）仍按系统故障报，不冒充「码错」', async () => {
      const svc = makeSms(
        fakeRedis(),
        fakeAliyun({
          CheckSmsVerifyCode: { Code: 'Forbidden.NoPermission', Message: 'x' },
        })
      );
      await svc.send('13800000016', 'login', '1.1.1.1');
      assert.match(
        (await rejection(svc.verify('13800000016', '000000', 'login'))) || '',
        /稍后再试/
      );
    });

    it('格式不对的码不计次数也不调阿里云', async () => {
      const aliyun = fakeAliyun();
      const redis = fakeRedis();
      const svc = makeSms(redis, aliyun);
      await svc.send('13800000014', 'login', '1.1.1.1');
      assert.strictEqual(
        await svc.verify('13800000014', 'abc', 'login'),
        false
      );
      assert.strictEqual(redis.kv['sms:tries:13800000014'], undefined);
      assert.strictEqual(
        aliyun.calls.filter(c => c.Action === 'CheckSmsVerifyCode').length,
        0
      );
    });
  });

  /** 端点层：替身 authService / userService / smsAuthService，只验分支走向。 */
  function makeEndpoint(
    opts: { existing?: boolean; verify?: boolean; captcha?: boolean } = {}
  ) {
    const ep: any = new AuthHTTPService();
    const log: any = {
      created: null as any,
      issued: [] as string[],
      sent: [] as any[],
      pwd: null,
    };
    ep.ctx = {
      ip: '9.9.9.9',
      get: (h: string) =>
        h === 'origin' ? 'https://invest-journey.cn' : undefined,
    };
    ep.captchaService = { checkCaptcha: async () => opts.captcha !== false };
    ep.authService = {
      findByPhone: async () =>
        opts.existing ? { id: '1', role: 'user' } : null,
      issueToken: async (uid: string) => (
        log.issued.push(uid), { token: 't-' + uid, expire: 1 }
      ),
      setPassword: async (p: string, pw: string) => (log.pwd = [p, pw]),
    };
    ep.smsAuthService = {
      enabled: () => true,
      send: async (...a: any[]) => log.sent.push(a),
      verify: async () => opts.verify !== false,
    };
    ep.userService = {
      createUser: async (dto: any) => (
        (log.created = dto),
        { success: true, data: { token: 'new', expire: 2 } }
      ),
    };
    ep.investDb = { exec: async () => undefined };
    return { ep, log };
  }

  describe('短信端点', () => {
    it('新号未同意协议：返回 needAgree，不核码不建号', async () => {
      const { ep, log } = makeEndpoint({ existing: false });
      ep.smsAuthService.verify = async () => assert.fail('不应核码');
      const r = await ep.smsLogin({
        phoneNumber: '13800000020',
        code: '123456',
      });
      assert.deepStrictEqual(r.data, { needAgree: true });
      assert.strictEqual(log.created, null);
    });

    it('新号同意后：核码通过即建号，昵称自动生成，返回 isNew', async () => {
      const { ep, log } = makeEndpoint({ existing: false });
      const r = await ep.smsLogin({
        phoneNumber: '13800000021',
        code: '123456',
        agree: true,
      });
      assert.strictEqual(r.data.isNew, true);
      assert.strictEqual(r.data.token, 'new');
      assert.match(log.created.nickName, /^用户_\d{6}$/);
      assert.ok(log.created.password.length >= 32, '随机密码');
    });

    it('老号：核码通过直接签 token', async () => {
      const { ep, log } = makeEndpoint({ existing: true });
      const r = await ep.smsLogin({
        phoneNumber: '13800000022',
        code: '123456',
      });
      assert.strictEqual(r.data.token, 't-13800000022');
      assert.deepStrictEqual(log.issued, ['13800000022']);
    });

    it('码不对：拒绝，不签 token', async () => {
      const { ep, log } = makeEndpoint({ existing: true, verify: false });
      assert.match(
        (await rejection(
          ep.smsLogin({ phoneNumber: '13800000023', code: '1' })
        )) || '',
        /错误或已过期/
      );
      assert.deepStrictEqual(log.issued, []);
    });

    it('发送：图片验证码不对不发；重置密码只给已注册的号发', async () => {
      let { ep, log } = makeEndpoint({ captcha: false });
      assert.match(
        (await rejection(
          ep.smsSend({ phoneNumber: '13800000024', scene: 'login' })
        )) || '',
        /图片验证码/
      );
      assert.strictEqual(log.sent.length, 0);
      ({ ep, log } = makeEndpoint({ existing: false }));
      assert.match(
        (await rejection(
          ep.smsSend({ phoneNumber: '13800000025', scene: 'reset' })
        )) || '',
        /还没有注册/
      );
      assert.strictEqual(log.sent.length, 0);
      ({ ep, log } = makeEndpoint({ existing: true }));
      await ep.smsSend({ phoneNumber: '13800000026', scene: 'reset' });
      assert.deepStrictEqual(log.sent[0], ['13800000026', 'reset', '9.9.9.9']);
    });

    it('手机号格式不对直接拒', async () => {
      const { ep } = makeEndpoint();
      assert.match(
        (await rejection(
          ep.smsSend({ phoneNumber: '12345', scene: 'login' })
        )) || '',
        /手机号/
      );
    });

    it('重置密码：密码过短拒绝；成功后改密并直接登录', async () => {
      const { ep, log } = makeEndpoint({ existing: true });
      assert.match(
        (await rejection(
          ep.smsResetPassword({
            phoneNumber: '13800000027',
            code: '1',
            password: '123',
          })
        )) || '',
        /6~64/
      );
      const r = await ep.smsResetPassword({
        phoneNumber: '13800000027',
        code: '123456',
        password: 'newpass1',
      });
      assert.deepStrictEqual(log.pwd, ['13800000027', 'newpass1']);
      assert.strictEqual(r.data.token, 't-13800000027');
    });

    it('自动昵称按北京时间', () => {
      assert.strictEqual(
        autoNickName(Date.UTC(2026, 9, 27, 1, 2, 3)),
        '用户_090203'
      );
    });
  });
});
