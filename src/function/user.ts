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
    await this.guardSignupRate();
    return await this.userService.createUser(data);
  }

  /**
   * 注册频次闸（按来源 IP）。
   *
   * 起因（2026-08-30 复盘）：8/25~8/26 两晚建了 39 个号，全部零埋点、零 AI 调用、
   * 无一条 signup_success——没走本站注册框；每个号又各占一个不同的分钟（最高 1/分钟）。
   * 来源无法从聚合数据判定（后端与 invest-journey.cn 共用 user 表，那边的推广会长成
   * 一模一样的形状），但无论答案是什么，这个端点本身的敞口是确定的：免登录、无频次
   * 限制，而 8/23 修好「注册即送 14 天」之后，每建一个号就是白送 14 天不限次 Iris。
   *
   * 阈值取得宽：真人一辈子在一个 IP 上注册一次；5/时、20/天 连公司或学校出口 NAT
   * 都碰不到，却能把 1/分钟 的自动注册在第 5 个上截停。**若那 39 个号真是
   * invest-journey 的推广用户，他们来自各自的 IP，本闸对他们零影响**——这正是按 IP
   * 而不是按总量限的原因。
   *
   * 失败开放：Redis 异常时放行。注册是唯一的入口漏斗层，宁可少拦不可误杀
   * （与 entitlement.check 的取舍一致）。
   */
  private async guardSignupRate(): Promise<void> {
    const ip =
      this.ctx.get('x-forwarded-for')?.split(',')[0]?.trim() || this.ctx.ip || '';
    if (!ip) return;
    const now = new Date();
    const buckets: { key: string; limit: number; ttl: number }[] = [
      { key: `signup:h:${now.toISOString().slice(0, 13)}:${ip}`, limit: 5, ttl: 3600 },
      { key: `signup:d:${now.toISOString().slice(0, 10)}:${ip}`, limit: 20, ttl: 86400 },
    ];
    for (const b of buckets) {
      let n: number;
      try {
        n = await this.redisService.incr(b.key);
        if (n === 1) await this.redisService.expire(b.key, b.ttl);
      } catch {
        return; // Redis 不可用 ⟹ 放行（闸门不能变成注册的单点故障）
      }
      // 超限判定放在 try 之外：否则自己抛的业务错误会被自己的 catch 吞掉变成放行
      if (n > b.limit) throw R.error('注册过于频繁，请稍后再试');
    }
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
    const res = await this.userService.getUserById(uid);
    // 管理员视角开关（/user/roleView）：展示角色跟随当前会话（会话 role 可能被切成
    // user），realRole 供前端渲染切换入口；会话读取失败不影响资料返回。
    if (res?.success && res.data) {
      try {
        const token =
          this.ctx.header?.token ||
          String(this.ctx.header?.authorization || '').replace('Bearer ', '');
        const raw = token ? await this.redisService.get(`token:${token}`) : null;
        if (raw) {
          const sess = JSON.parse(raw);
          if (sess?.role) res.data.role = sess.role;
          res.data.realRole = sess?.realRole || sess?.role || res.data.role;
        }
      } catch {
        // 忽略：无会话视角信息时按库内角色返回
      }
      if (!res.data.realRole) res.data.realRole = res.data.role;
    }
    return res;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '管理员视角切换（测试用）：只改当前登录会话的角色',
    functionName: 'roleView',
    name: 'roleView',
    path: '/user/roleView',
    method: 'post',
  })
  async roleView(@Body(ALL) body: { view?: string }): Promise<any> {
    // 只改「当前这个 token 的会话」：库里 role 不动，登出重登自然恢复管理员本色。
    // 权限依据 realRole（首次切换时由会话 role=admin 背书），普通用户拿不到 admin。
    const token =
      this.ctx.header?.token ||
      String(this.ctx.header?.authorization || '').replace('Bearer ', '');
    if (!token) throw R.unauthorizedError('未登录');
    const key = `token:${token}`;
    const raw = await this.redisService.get(key);
    if (!raw) throw R.unauthorizedError('登录已过期');
    const sess = JSON.parse(raw);
    if ((sess.realRole || sess.role) !== 'admin') {
      throw R.forbiddenError('仅管理员可切换视角');
    }
    const view = body?.view === 'user' ? 'user' : 'admin';
    const next = { ...sess, role: view, realRole: 'admin' };
    const ttl = await this.redisService.ttl(key);
    if (ttl && ttl > 0) {
      await this.redisService
        .multi()
        .set(key, JSON.stringify(next))
        .expire(key, ttl)
        .exec();
    } else {
      await this.redisService.set(key, JSON.stringify(next));
    }
    return { success: true, data: { role: view, realRole: 'admin' } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '更新用户信息',
    functionName: 'updateUserInfo',
    name: 'updateUserInfo',
    path: '/user/updateUserInfo',
    method: 'post',
  })
  async updateUserInfo(
    @Body(ALL) data: { userId?: string; nickName?: string; avatar?: string }
  ): Promise<any> {
    // 2026-08-10 开放注册收紧：写操作只认登录态身份，body 的 userId 仅作展示兼容、
    // 不再作为写目标（旧实现完全信任 body ⟹ 任何登录用户可改任意人的昵称/头像）。
    // 两个前端（front-end-journey / invest-journey）都带 token 调用，行为不受影响。
    const userId = this.ctx.userInfo?.userId;
    if (!userId) throw R.unauthorizedError('请先登录');
    const { nickName, avatar } = data;
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
    // 只认登录态身份，绝不回退到 body.userId。
    // 旧实现「取不到登录态就信 body.userId」是免费开会员的口子：auth 中间件只对
    // /invest/* 强制登录，/user/* 一律放行，因此无 token 也能打进来——任何人给任意
    // 手机号开 30/365 天会员，并连带在 order 表落一笔 ¥29/¥199 的假订单，污染
    // 「月收入 ≥ 月成本」这个北极星。8/1 恢复收费后该口子等同于送钱。
    // 与 ac28727 对 updateUserInfo 的加固同款（当次遗漏了本端点）。
    const userId = this.ctx.userInfo?.userId;
    if (!userId) throw R.unauthorizedError('请先登录');
    if (!data.plan || !['monthly', 'yearly'].includes(data.plan)) throw R.error('plan 参数无效');
    return await this.userService.activateMembership(userId, data.plan, data.channel);
  }
}
