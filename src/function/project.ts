import { Provide, ServerlessTrigger, ServerlessTriggerType, Inject, Body, ALL } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import * as crypto from 'crypto';
import { NoAuth } from '../decorator/noAuth';
import { EntitlementService } from '../service/entitlement';
import { resolveUserInfo } from '../common/admin.guard';
import { R } from '../common/base.error.utils';
import {
  TRIAL_DAILY_LIMIT, TRIAL_PROJECTS, TRIAL_TICKET_TTL_SEC,
  signTrialTicket, trialConfigured, trialQuotaKey,
} from '../service/project/trial';

/** 项目实战：在线试用的票据签发。 */
@Provide()
export class ProjectHTTPService {
  /** 当前时间；单测注入 */
  now: () => Date = () => new Date();

  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  entitlementService: EntitlementService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '项目实战在线试用：检查登录与每日次数后签发一次性票据',
    functionName: 'projectTrialTicket',
    name: 'projectTrialTicket',
    path: '/project/trial/ticket',
    method: 'post',
  })
  @NoAuth()
  async trialTicket(@Body(ALL) body: { projectId?: string; scenario?: string }): Promise<any> {
    const project = TRIAL_PROJECTS[String(body?.projectId || '')];
    if (!project) throw R.error('这个项目还没有开放在线试用');
    const scenario = String(body?.scenario || project.scenarios[0]);
    if (!project.scenarios.includes(scenario)) throw R.error('没有这个试用场景');
    if (!trialConfigured()) throw R.error('在线试用暂时不可用，请稍后再试');

    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    if (!userId) throw R.unauthorizedError('登录后即可在线试用');

    const member = (await this.entitlementService.check(userId, 'materials_pdf', {})).allowed;
    const limit = member ? TRIAL_DAILY_LIMIT.member : TRIAL_DAILY_LIMIT.user;
    const now = this.now();
    const key = trialQuotaKey(userId, now);
    const used = await this.redisService.incr(key);
    if (used === 1) await this.redisService.expire(key, 2 * 86400);
    if (used > limit) {
      throw R.forbiddenError(member
        ? `今天的 ${limit} 次在线试用已用完，明天再来`
        : `今天的 ${limit} 次在线试用已用完。会员每天 ${TRIAL_DAILY_LIMIT.member} 次，也可以下载源码在自己电脑上运行`);
    }

    const exp = Math.floor(now.getTime() / 1000) + TRIAL_TICKET_TTL_SEC;
    const ticket = signTrialTicket(
      { jti: crypto.randomBytes(12).toString('hex'), exp, project: body.projectId, scenario },
      String(process.env.PROJECT_TRIAL_TICKET_SECRET),
    );
    return {
      success: true,
      data: {
        url: String(process.env.PROJECT_TRIAL_URL).replace(/\/+$/, '') + '/run',
        ticket, scenario, remaining: limit - used, limit, member,
      },
    };
  }
}
