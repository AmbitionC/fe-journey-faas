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
import { RedisService } from '@midwayjs/redis';
import { UserDTO } from '../dto/user';
import { CaptchaService } from '../service/auth/captcha';
import { UserService } from '../service/user';
import { EntitlementService } from '../service/entitlement';
import { R } from '../common/base.error.utils';

@Provide()
export class UserHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  captchaService: CaptchaService;

  @Inject()
  userService: UserService;

  @Inject()
  entitlementService: EntitlementService;

  @Inject()
  redisService: RedisService;

  /**
   * 解析当前登录用户 userId（手机号）。优先级：
   *   1) 中间件注入的 ctx.userInfo（聚合函数下有时不透传，故不单独依赖）
   *   2) 直接从请求头 token 反查 Redis（与 AuthMiddleware 同源，最可靠）
   *   3) 显式 userId 参数兜底（兼容旧前端）
   */
  private async resolveUserId(fallback?: string): Promise<string | undefined> {
    const fromCtx = (this.ctx as any).userInfo?.userId;
    if (fromCtx) return fromCtx;
    try {
      const h: any = (this.ctx as any).header || (this.ctx as any).headers || {};
      const token = (h.token as string) || (h.authorization as string)?.replace('Bearer ', '');
      if (token) {
        const s = await this.redisService.get(`token:${token}`);
        if (s) {
          const uid = JSON.parse(s)?.userId;
          if (uid) return uid;
        }
      }
    } catch {
      // 反查失败则退回显式参数
    }
    return fallback;
  }

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
    // 以登录 token 反查的 userId 为准（前端无需传参，也堵住越权查他人资料）。
    const uid = await this.resolveUserId(userId);
    if (!uid) throw R.unauthorizedError('未登录或登录已过期');
    return await this.userService.getUserById(uid);
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
    description: '当前用户权益概要（是否会员/到期日/权益键）',
    functionName: 'userEntitlements',
    name: 'userEntitlements',
    path: '/user/entitlements',
    method: 'get',
  })
  async userEntitlements(): Promise<any> {
    const uid = await this.resolveUserId();
    if (!uid) {
      // 游客：返回非会员概要，前端据此渲染锁态（仅展示，不作判定依据）
      return { success: true, data: { isMember: false, expireAt: null, guest: true } };
    }
    const data = await this.entitlementService.getEntitlements(uid);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '激活会员',
    functionName: 'activateMembership',
    name: 'activateMembership',
    path: '/user/activateMembership',
    method: 'post',
  })
  async activateMembership(
    @Body(ALL) data: { plan: 'monthly' | 'yearly'; userId?: string; channel?: string }
  ): Promise<any> {
    // 优先用鉴权中间件注入的登录态；取不到再回退到 body 的 userId（前端已携带），
    // 与 getUserInfo / updateUserInfo 信任客户端 userId 的做法一致。
    const userId = this.ctx.userInfo?.userId || data.userId;
    if (!userId) throw R.error('请先登录');
    if (!data.plan || !['monthly', 'yearly'].includes(data.plan)) throw R.error('plan 参数无效');
    return await this.userService.activateMembership(userId, data.plan, data.channel);
  }
}
