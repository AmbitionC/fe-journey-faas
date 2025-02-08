import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { UserDTO } from '../dto/user';
import { CaptchaService } from '../service/auth/captcha';
import { UserService } from '../service/user';
import { R } from '../common/base.error.utils';

@Provide()
export class UserHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  captchaService: CaptchaService;

  @Inject()
  userService: UserService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '创建账号',
    functionName: 'create',
    name: 'http',
    path: '/user/create',
    method: 'post',
  })
  async create(@Body(ALL) data: UserDTO): Promise<any> {
    const { captcha, captchaId } = data;
    const result = await this.captchaService.checkCaptcha(captchaId, captcha);
    if (!result) throw R.error('验证码错误');
    return await this.userService.createUser(data);
  }
}
