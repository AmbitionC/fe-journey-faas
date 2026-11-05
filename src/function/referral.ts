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
import { R } from '../common/base.error.utils';
import { resolveUserInfo } from '../common/admin.guard';
import { clientIpFromCtx } from '../common/clientIp';
import { NoAuth } from '../decorator/noAuth';
import { ReferralService } from '../service/referral';
import { programView } from '../mcp/referral';

/** bind 失败时给用户看的话 */
const BIND_ERRORS: Record<string, string> = {
  no_code: '请填写邀请码',
  unknown_code: '邀请码不存在，请核对后再试',
  self: '不能填写自己的邀请码',
  circular: '你已经邀请过对方，不能再互相邀请',
  exists: '你已经填过邀请码了',
  too_late: '邀请码只能在注册后 7 天内补填',
};

/**
 * 邀请裂变通用接口（Agent Journey / Invest Journey / 栗栗学英语 共用一套账户，各传自己的 product）。
 * 规则见 mcp/referral.ts。
 */
@Provide()
export class ReferralHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  referralService: ReferralService;

  private async requireUser(): Promise<string> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    if (!info?.userId) throw R.unauthorizedError('未登录或登录已过期');
    return info.userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description:
      '邀请规则（按产品）；带 code 时顺带校验邀请码、返回邀请人脱敏昵称（落地页横幅用）',
    functionName: 'referralProgram',
    name: 'referralProgram',
    path: '/referral/program',
    method: 'get',
  })
  @NoAuth()
  async program(
    @Query('product') product?: string,
    @Query('code') code?: string
  ): Promise<any> {
    const data: any = { program: programView(product) };
    if (code) {
      data.invite = await this.referralService
        .lookup(code)
        .catch(() => ({ valid: false, inviterNick: null }));
    }
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '我的邀请：邀请码、成绩、本月/累计计奖进度、能否补填邀请码',
    functionName: 'referralMe',
    name: 'referralMe',
    path: '/referral/me',
    method: 'get',
  })
  async me(@Query('product') product?: string): Promise<any> {
    const uid = await this.requireUser();
    return {
      success: true,
      data: await this.referralService.stats(uid, product),
    };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '注册后补填邀请码（注册 7 天内、未绑定过邀请人）',
    functionName: 'referralBind',
    name: 'referralBind',
    path: '/referral/bind',
    method: 'post',
  })
  async bind(
    @Body(ALL) body: { code?: string; product?: string }
  ): Promise<any> {
    const uid = await this.requireUser();
    const r = await this.referralService.bind(
      uid,
      String(body?.code || ''),
      clientIpFromCtx(this.ctx),
      body?.product
    );
    if (r.status === 'ignored')
      throw R.error(BIND_ERRORS[r.reason] || '邀请码无效');
    return { success: true, data: r };
  }
}
