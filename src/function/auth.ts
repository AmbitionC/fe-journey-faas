import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { LoginDTO } from '../dto/auth';
import { CaptchaService } from '../service/auth/captcha.service';

@Provide()
export class AuthHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  captchaService: CaptchaService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取图片验证码',
    functionName: 'queryCaptcha',
    name: 'http',
    path: '/auth/queryCaptcha',
    method: 'get',
  })
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
    description: '登录接口',
    functionName: 'signIn',
    name: 'http',
    path: '/auth/signIn',
    method: 'post',
  })
  async signIn(@Body(ALL) loginDTO: LoginDTO): Promise<any> {}
}
