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
import { LoginDTO } from '../dto/auth';
import { CaptchaService } from '../service/auth/captcha';
import { AuthService } from '../service/auth';
import { NoAuth } from '../decorator/noAuth';
import { R } from '../common/base.error.utils';

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
