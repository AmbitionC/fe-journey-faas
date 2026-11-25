import { Provide, ServerlessTrigger, ServerlessTriggerType, Inject, Body, Query, ALL } from '@midwayjs/core';
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
import { SOURCE_PROJECTS, SOURCE_URL_EXPIRES_SEC, loadSourcePackage } from '../service/project/source';
import { OssService } from '../service/content/oss';

/** 项目实战：在线试用的票据签发、会员源码下载。 */
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

  @Inject()
  ossService: OssService;

  /** 代码包根目录；单测注入 */
  sourceRoot: string | undefined;

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
    if (limit <= 0) throw R.forbiddenError('现场运行是会员功能，开通后每天 ' + TRIAL_DAILY_LIMIT.member + ' 次；示例回放不用开通就能看');
    const now = this.now();
    const key = trialQuotaKey(userId, now);
    const used = await this.redisService.incr(key);
    if (used === 1) await this.redisService.expire(key, 2 * 86400);
    if (used > limit) {
      throw R.forbiddenError(`今天的 ${limit} 次在线试用已用完，明天再来`);
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

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '项目实战在线试用：今天还剩几次（只读，不占次数）',
    functionName: 'projectTrialQuota',
    name: 'projectTrialQuota',
    path: '/project/trial/quota',
    method: 'get',
  })
  @NoAuth()
  async trialQuota(): Promise<any> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    // 没登录不算错：页面据此不显示次数
    if (!userId) return { success: true, data: null };
    const member = (await this.entitlementService.check(userId, 'materials_pdf', {})).allowed;
    const limit = member ? TRIAL_DAILY_LIMIT.member : TRIAL_DAILY_LIMIT.user;
    const used = Number(await this.redisService.get(trialQuotaKey(userId, this.now()))) || 0;
    return { success: true, data: { limit, remaining: Math.max(0, limit - used), member } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '项目实战源码下载（会员权益）：签发 1 小时临时链接',
    functionName: 'projectSourceDownload',
    name: 'projectSourceDownload',
    path: '/project/source/download',
    method: 'get',
  })
  @NoAuth()
  async sourceDownload(@Query('projectId') projectId?: string): Promise<any> {
    const project = SOURCE_PROJECTS[String(projectId || '')];
    if (!project) throw R.error('这个项目还没有开放源码下载');

    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    if (!userId) throw R.unauthorizedError('登录后即可下载源码');
    const member = (await this.entitlementService.check(userId, 'materials_pdf', {})).allowed;
    if (!member) throw R.forbiddenError('源码下载是会员权益，开通会员后即可下载');

    const pkg = loadSourcePackage(String(projectId), this.sourceRoot);
    if (!pkg) throw R.error('源码包暂时不可用，请稍后再试');
    // 对象名带内容哈希：代码更新后自然是新对象，已有的不重复上传
    if (!(await this.ossService.rawMeta(pkg.objKey))) {
      await this.ossService.putPrivate(pkg.objKey, pkg.buf, 'application/zip');
    }
    // 站点是 https，签名链接也必须是，否则浏览器会拦下载
    const url = this.ossService.signedUrl(pkg.objKey, SOURCE_URL_EXPIRES_SEC, project.filename).replace(/^http:\/\//, 'https://');
    return { success: true, data: { url, filename: project.filename, size: pkg.buf.length, expiresInSec: SOURCE_URL_EXPIRES_SEC } };
  }
}
