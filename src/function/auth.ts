import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { CaptchaService } from '../service/auth/captcha.service';

@Provide()
export class AuthHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  captchaService: CaptchaService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
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
}
