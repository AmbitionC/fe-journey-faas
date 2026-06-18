import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  Query,
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
    functionName: 'createAccount',
    name: 'createAccount',
    path: '/user/create',
    method: 'post',
  })
  async createAccount(@Body(ALL) data: UserDTO): Promise<any> {
    const { captcha, captchaId } = data;
    const result = await this.captchaService.checkCaptcha(captchaId, captcha);
    if (!result) throw R.error('验证码错误');
    return await this.userService.createUser(data);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取用户信息',
    functionName: 'getUserInfo',
    name: 'getUserInfo',
    path: '/user/getUserInfo',
    method: 'get',
  })
  async getUserInfo(@Query('userId') userId: string): Promise<any> {
    return await this.userService.getUserById(userId);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '更新用户信息',
    functionName: 'updateUserInfo',
    name: 'updateUserInfo',
    path: '/user/updateUserInfo',
    method: 'post',
  })
  async updateUserInfo(
    @Body(ALL) data: { userId: string; nickName?: string; avatar?: string }
  ): Promise<any> {
    const { userId, nickName, avatar } = data;
    if (!userId) throw R.error('用户ID不能为空');
    return await this.userService.updateUser(userId, { nickName, avatar });
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '激活会员',
    functionName: 'activateMembership',
    name: 'activateMembership',
    path: '/user/activateMembership',
    method: 'post',
  })
  async activateMembership(
    @Body(ALL) data: { plan: 'monthly' | 'yearly'; userId?: string }
  ): Promise<any> {
    // 优先用鉴权中间件注入的登录态；取不到再回退到 body 的 userId（前端已携带），
    // 与 getUserInfo / updateUserInfo 信任客户端 userId 的做法一致。
    const userId = this.ctx.userInfo?.userId || data.userId;
    if (!userId) throw R.error('请先登录');
    if (!data.plan || !['monthly', 'yearly'].includes(data.plan)) throw R.error('plan 参数无效');
    return await this.userService.activateMembership(userId, data.plan);
  }
}
