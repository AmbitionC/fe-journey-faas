import { Inject, Provide, ILogger } from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { callRpc } from '../../common/aliyunRpc';
import { beijingDay } from '../../common/signupSite';
import { R } from '../../common/base.error.utils';

/**
 * 短信验证码（阿里云号码认证服务·短信认证，2026-10-27 接入）。
 *
 * 为什么用「号码认证·短信认证」而不是常规「短信服务」：常规短信的签名要企业资质
 * 实名报备，个人账号办不下来；短信认证允许个人实名账号使用阿里云赠送的通用签名
 * 与赠送模板，验证码由阿里云生成、保存、核验，本服务不落验证码本身。
 *
 * 防刷（每条短信都花钱，且发送端点免登录，最怕被拿去轰炸他人手机）：
 * - 发送前必须先过图片验证码（在 function 层）；
 * - 同号 60 秒冷却、每天 5 条；同 IP 每小时 10 条、每天 20 条；全站每天封顶
 *   SMS_DAILY_CAP（默认 300）——被刷穿的最坏代价是一天十几块钱；
 * - 与注册闸相反，这里 **失败关闭**：Redis 不可用时拒发（密码登录不受影响），
 *   不能让计数器故障变成无限发送。
 * 核验侧：一次发送最多核 5 次（防爆破 6 位码），核验通过即作废（一码一用），
 * 且发码时记下用途（登录 / 重置密码），用途不符不认。
 *
 * 环境变量：SMS_ACCESS_KEY_ID / SMS_ACCESS_KEY_SECRET（RAM 子账号，仅
 * dypns:SendSmsVerifyCode + dypns:CheckSmsVerifyCode）、SMS_SIGN_NAME（赠送签名名称）；
 * 可选 SMS_TEMPLATE_LOGIN（默认 100001 登录/注册）、SMS_TEMPLATE_RESET（默认 100003
 * 重置密码）、SMS_DAILY_CAP。三项必填缺任一 ⟹ 功能视为未开通，前端不展示入口。
 */
export type SmsScene = 'login' | 'reset';

export const SMS_LIMITS = {
  cooldownSec: 60,
  perPhoneDaily: 5,
  perIpHourly: 10,
  perIpDaily: 20,
  globalDailyDefault: 300,
  validSec: 300,
  codeLength: 6,
  maxTries: 5,
};

const ENDPOINT = 'https://dypnsapi.aliyuncs.com/';
const VERSION = '2017-05-25';

interface SmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templates: Record<SmsScene, string>;
  dailyCap: number;
}

/** 阿里云发送失败码 → 给用户看的话（其余一律「稍后再试」，原码进日志）。 */
export function sendErrorMessage(raw?: string): string {
  // 文档写 BUSINESS_LIMIT_CONTROL，实测业务码带 isv. 前缀（如 isv.ValidateFail），两种都认
  const code = String(raw || '').replace(/^isv\./i, '');
  if (code === 'BUSINESS_LIMIT_CONTROL')
    return '该手机号今天获取验证码的次数已达上限，请明天再试';
  if (code === 'FREQUENCY_FAIL') return '获取验证码太频繁，请稍后再试';
  if (code === 'MOBILE_NUMBER_ILLEGAL') return '手机号格式不正确';
  return '短信发送失败，请稍后再试';
}

@Provide()
export class SmsAuthService {
  @Inject()
  redisService: RedisService;

  @Inject()
  logger: ILogger;

  /** 测试注入：替换真实 HTTP 调用。 */
  fetchImpl?: (url: string, init: any) => Promise<any>;

  config(): SmsConfig | null {
    const e = process.env;
    const accessKeyId = (e.SMS_ACCESS_KEY_ID || '').trim();
    const accessKeySecret = (e.SMS_ACCESS_KEY_SECRET || '').trim();
    const signName = (e.SMS_SIGN_NAME || '').trim();
    if (!accessKeyId || !accessKeySecret || !signName) return null;
    const cap = Number(e.SMS_DAILY_CAP);
    return {
      accessKeyId,
      accessKeySecret,
      signName,
      templates: {
        login: (e.SMS_TEMPLATE_LOGIN || '').trim() || '100001',
        reset: (e.SMS_TEMPLATE_RESET || '').trim() || '100003',
      },
      dailyCap:
        Number.isFinite(cap) && cap > 0 ? cap : SMS_LIMITS.globalDailyDefault,
    };
  }

  enabled(): boolean {
    return !!this.config();
  }

  private rpc(cfg: SmsConfig, action: string, params: Record<string, any>) {
    return callRpc({
      endpoint: ENDPOINT,
      action,
      version: VERSION,
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      params,
      fetchImpl: this.fetchImpl,
    });
  }

  /** 计数 +1 并在首次时设 TTL，返回当前计数。 */
  private async bump(key: string, ttl: number): Promise<number> {
    const n = await this.redisService.incr(key);
    if (n === 1) await this.redisService.expire(key, ttl);
    return n;
  }

  /**
   * 发送配额：冷却 → 同号日上限 → 同 IP 时/日上限 → 全站日上限。任一超限抛业务错误；
   * Redis 异常抛「暂不可用」（失败关闭）。
   */
  async consumeQuota(
    phone: string,
    ip: string,
    dailyCap: number
  ): Promise<void> {
    const now = new Date();
    const day = beijingDay(now.getTime());
    const hour = now.toISOString().slice(0, 13);
    let reject: string | null = null;
    try {
      const fresh = await this.redisService.set(
        `sms:cd:${phone}`,
        '1',
        'EX',
        SMS_LIMITS.cooldownSec,
        'NX'
      );
      if (!fresh) {
        reject = `获取验证码太频繁，请 ${SMS_LIMITS.cooldownSec} 秒后再试`;
      } else if (
        (await this.bump(`sms:pd:${day}:${phone}`, 86400)) >
        SMS_LIMITS.perPhoneDaily
      ) {
        reject = '该手机号今天获取验证码的次数已达上限，请明天再试';
      } else if (
        ip &&
        (await this.bump(`sms:ih:${hour}:${ip}`, 3600)) > SMS_LIMITS.perIpHourly
      ) {
        reject = '获取验证码太频繁，请稍后再试';
      } else if (
        ip &&
        (await this.bump(`sms:id:${day}:${ip}`, 86400)) > SMS_LIMITS.perIpDaily
      ) {
        reject = '获取验证码太频繁，请明天再试';
      } else if ((await this.bump(`sms:gd:${day}`, 86400)) > dailyCap) {
        this.logger.warn('[sms] 全站当日发送量已达上限 %s', dailyCap);
        reject = '今天的短信验证码额度已用完，请先用密码登录';
      }
    } catch (e: any) {
      this.logger.warn('[sms] 配额计数失败，拒绝发送：%s', e?.message);
      throw R.error('短信服务暂不可用，请稍后再试');
    }
    // 业务拒绝放在 try 之外抛（同注册闸：别让自己的 catch 吞掉）
    if (reject) throw R.error(reject);
  }

  /** 发送验证码（调用方须已核过图片验证码与手机号格式）。 */
  async send(phone: string, scene: SmsScene, ip: string): Promise<void> {
    const cfg = this.config();
    if (!cfg) throw R.error('短信验证暂未开通');
    await this.consumeQuota(phone, ip, cfg.dailyCap);
    let res: any;
    try {
      res = await this.rpc(cfg, 'SendSmsVerifyCode', {
        PhoneNumber: phone,
        SignName: cfg.signName,
        TemplateCode: cfg.templates[scene],
        TemplateParam: JSON.stringify({
          code: '##code##',
          min: String(Math.round(SMS_LIMITS.validSec / 60)),
        }),
        CodeLength: SMS_LIMITS.codeLength,
        CodeType: 1,
        ValidTime: SMS_LIMITS.validSec,
        Interval: SMS_LIMITS.cooldownSec,
        DuplicatePolicy: 1,
      });
    } catch (e: any) {
      this.logger.warn('[sms] SendSmsVerifyCode 请求失败：%s', e?.message);
      throw R.error('短信发送失败，请稍后再试');
    }
    if (res?.Code !== 'OK') {
      this.logger.warn(
        '[sms] SendSmsVerifyCode 失败 code=%s msg=%s',
        res?.Code,
        res?.Message
      );
      throw R.error(sendErrorMessage(res?.Code));
    }
    try {
      await this.redisService.set(
        `sms:scene:${phone}`,
        scene,
        'EX',
        SMS_LIMITS.validSec
      );
      await this.redisService.del(`sms:tries:${phone}`);
    } catch (e: any) {
      // 短信已发出但记不下用途 ⟹ 这条码将无法核验；让用户稍后重发
      this.logger.warn('[sms] 记录发送状态失败：%s', e?.message);
      throw R.error('短信服务暂不可用，请稍后再试');
    }
  }

  /** 核验验证码；通过返回 true 并作废该码。 */
  async verify(phone: string, code: string, scene: SmsScene): Promise<boolean> {
    const cfg = this.config();
    if (!cfg) throw R.error('短信验证暂未开通');
    const v = String(code || '').trim();
    if (!/^\d{4,8}$/.test(v)) return false;
    const sceneKey = `sms:scene:${phone}`;
    const triesKey = `sms:tries:${phone}`;
    let tooMany = false;
    try {
      if ((await this.redisService.get(sceneKey)) !== scene) return false;
      if (
        (await this.bump(triesKey, SMS_LIMITS.validSec)) > SMS_LIMITS.maxTries
      ) {
        await this.redisService.del(sceneKey);
        tooMany = true;
      }
    } catch (e: any) {
      this.logger.warn('[sms] 核验计数失败：%s', e?.message);
      throw R.error('短信服务暂不可用，请稍后再试');
    }
    if (tooMany) throw R.error('验证码错误次数过多，请重新获取');
    let res: any;
    try {
      res = await this.rpc(cfg, 'CheckSmsVerifyCode', {
        PhoneNumber: phone,
        VerifyCode: v,
      });
    } catch (e: any) {
      this.logger.warn('[sms] CheckSmsVerifyCode 请求失败：%s', e?.message);
      throw R.error('验证码校验失败，请稍后再试');
    }
    // 码错时阿里云不回 Code=OK+VerifyResult=UNKNOWN，而是直接回业务码 isv.ValidateFail
    // （2026-10-27 线上自检实测）。isv.* 一律按「不通过」；其余（鉴权/系统/网关）才是故障。
    if (res?.Code !== 'OK' && /^isv\./i.test(String(res?.Code))) {
      return false;
    }
    if (res?.Code !== 'OK') {
      this.logger.warn(
        '[sms] CheckSmsVerifyCode 失败 code=%s msg=%s',
        res?.Code,
        res?.Message
      );
      throw R.error('验证码校验失败，请稍后再试');
    }
    const pass = res?.Model?.VerifyResult === 'PASS';
    if (pass) {
      await Promise.resolve(this.redisService.del(sceneKey, triesKey)).catch(
        () => {}
      );
    }
    return pass;
  }
}
