import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
} from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { Context } from '@midwayjs/faas';
import { ApiResponse } from '@midwayjs/swagger';
import { randomUUID } from 'crypto';
import { LoginDTO } from '../dto/auth';
import { UserDTO } from '../dto/user';
import { CaptchaService } from '../service/auth/captcha';
import { AuthService } from '../service/auth';
import { SmsAuthService, SmsScene } from '../service/auth/sms';
import { UserService } from '../service/user';
import { InvestDbService } from '../service/invest/db';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';
import { phone as phoneRule } from '../common/common.validate.rules';
import { recordSignupSource } from '../common/signupSite';

function assertPhone(v: unknown): string {
  const p = String(v || '').trim();
  if (!p || phoneRule.validate(p).error) throw R.error('手机号格式不正确');
  return p;
}

/** 短信登录自动建号的默认昵称，与前端注册框留空时的「用户_HHMMSS」同一形制（北京时间）。 */
export function autoNickName(now: number = Date.now()): string {
  return `用户_${new Date(now + 8 * 3600 * 1000)
    .toISOString()
    .slice(11, 19)
    .replace(/:/g, '')}`;
}

@Provide()
export class AuthHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  captchaService: CaptchaService;

  @Inject()
  authService: AuthService;

  @Inject()
  redisService: RedisService;

  @Inject()
  smsAuthService: SmsAuthService;

  @Inject()
  userService: UserService;

  @Inject()
  investDb: InvestDbService;

  private clientIp(): string {
    return (
      this.ctx.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      this.ctx.ip ||
      ''
    );
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description:
      '短信验证是否已开通（前端据此决定是否展示短信登录 / 忘记密码入口）',
    functionName: 'smsConfig',
    name: 'smsConfig',
    path: '/auth/sms/config',
    method: 'get',
  })
  @NoAuth()
  async smsConfig() {
    return { success: true, data: { enabled: this.smsAuthService.enabled() } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '发送短信验证码（须先过图片验证码）',
    functionName: 'smsSend',
    name: 'smsSend',
    path: '/auth/sms/send',
    method: 'post',
  })
  @NoAuth()
  async smsSend(
    @Body(ALL)
    body: {
      phoneNumber?: string;
      captchaId?: string;
      captcha?: string;
      scene?: string;
    }
  ): Promise<any> {
    const phone = assertPhone(body?.phoneNumber);
    const scene: SmsScene = body?.scene === 'reset' ? 'reset' : 'login';
    if (!this.smsAuthService.enabled()) throw R.error('短信验证暂未开通');
    const ok = await this.captchaService.checkCaptcha(
      String(body?.captchaId || ''),
      String(body?.captcha || '')
    );
    if (!ok) throw R.error('图片验证码错误');
    // 重置密码只给已注册的号发，省一条短信也省得给陌生号码发码
    if (scene === 'reset' && !(await this.authService.findByPhone(phone))) {
      throw R.error('该手机号还没有注册');
    }
    await this.smsAuthService.send(phone, scene, this.clientIp());
    return { success: true, data: { cooldown: 60 } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '短信验证码登录（未注册的号码在同意协议后自动建号）',
    functionName: 'smsLogin',
    name: 'smsLogin',
    path: '/auth/sms/login',
    method: 'post',
  })
  @NoAuth()
  async smsLogin(
    @Body(ALL) body: { phoneNumber?: string; code?: string; agree?: boolean }
  ): Promise<any> {
    const phone = assertPhone(body?.phoneNumber);
    const user = await this.authService.findByPhone(phone);
    // 新号先确认协议再核码：不消耗验证码，前端弹协议、同意后带 agree 重提
    if (!user && body?.agree !== true) {
      return { success: true, data: { needAgree: true } };
    }
    if (
      !(await this.smsAuthService.verify(
        phone,
        String(body?.code || ''),
        'login'
      ))
    ) {
      throw R.error('短信验证码错误或已过期');
    }
    if (user) {
      return {
        success: true,
        data: await this.authService.issueToken(phone, user.role),
      };
    }
    // 新号建号：随机密码（用户不知道），之后想用密码登录走「忘记密码」设一个
    const dto = Object.assign(new UserDTO(), {
      phoneNumber: phone,
      nickName: autoNickName(),
      password: randomUUID(),
    });
    const res = await this.userService.createUser(dto);
    await recordSignupSource(
      (sql, params) => this.investDb.exec(sql, params),
      phone,
      this.ctx.get('origin')
    );
    const { token, expire } = res?.data || {};
    return { success: true, data: { token, expire, isNew: true } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '短信验证码重设密码（成功后直接登录）',
    functionName: 'smsResetPassword',
    name: 'smsResetPassword',
    path: '/auth/sms/resetPassword',
    method: 'post',
  })
  @NoAuth()
  async smsResetPassword(
    @Body(ALL) body: { phoneNumber?: string; code?: string; password?: string }
  ): Promise<any> {
    const phone = assertPhone(body?.phoneNumber);
    const password = String(body?.password || '');
    if (password.length < 6 || password.length > 64)
      throw R.error('密码长度需为 6~64 位');
    const user = await this.authService.findByPhone(phone);
    if (!user) throw R.error('该手机号还没有注册');
    if (
      !(await this.smsAuthService.verify(
        phone,
        String(body?.code || ''),
        'reset'
      ))
    ) {
      throw R.error('短信验证码错误或已过期');
    }
    await this.authService.setPassword(phone, password);
    return {
      success: true,
      data: await this.authService.issueToken(phone, user.role),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取图片验证码',
    functionName: 'queryCaptcha',
    name: 'queryCaptcha',
    path: '/auth/queryCaptcha',
    method: 'get',
  })
  @NoAuth()
  async queryCaptcha() {
    const { id, imageBase64 } = await this.captchaService.getCaptcha({
      height: 35,
      width: 75,
      noise: 1,
      color: true,
    });

    return {
      code: 200,
      message: '图片验证码获取成功',
      data: {
        id,
        imageBase64,
      },
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '登录',
    functionName: 'login',
    name: 'login',
    path: '/auth/login',
    method: 'post',
  })
  @ApiResponse({
    type: LoginDTO,
  })
  @NoAuth()
  async login(@Body(ALL) data: LoginDTO): Promise<any> {
    const { captcha, captchaId } = data;
    const result = await this.captchaService.checkCaptcha(captchaId, captcha);
    if (!result) throw R.error('验证码错误');
    return await this.authService.login(data);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '退出登录',
    functionName: 'logout',
    name: 'logout',
    path: '/auth/logout',
    method: 'post',
  })
  @NoAuth()
  async logout(): Promise<any> {
    // 清除token和refreshToken
    const res = await this.redisService
      .multi()
      .del(`token:${this.ctx.token}`)
      .exec();
    if (res.some(item => item[0])) {
      throw R.error('退出登录失败');
    }
    return true;
  }
}
