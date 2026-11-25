import { Provide, ServerlessTrigger, ServerlessTriggerType, Inject, Body, Query, ALL } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { NoAuth } from '../decorator/noAuth';
import { EntitlementService } from '../service/entitlement';
import { resolveUserInfo } from '../common/admin.guard';
import { R } from '../common/base.error.utils';
import {
  TRIAL_PROJECTS, TRIAL_TICKET_TTL_SEC,
  TRIAL_RUN_TTL_SEC, TrialProject, openTrialMessage, signTrialTicket, trialCallbackBase, trialClaimKey,
  trialConfigured, trialDailyLimit, trialDoneKey, trialQuotaKey, trialRunKey, trialTokenKey, trialTokenLimit, usageNumber,
} from '../service/project/trial';
import { SOURCE_PROJECTS, SOURCE_URL_EXPIRES_SEC, loadSourcePackage } from '../service/project/source';
import { OssService } from '../service/content/oss';
import { IrisGuardService } from '../service/ai/irisGuard';
import { EventLogEntity } from '../entity/eventLog';
import { AiUsageLogEntity } from '../entity/aiUsageLog';

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

  @Inject()
  irisGuard: IrisGuardService;

  @InjectEntityModel(EventLogEntity)
  eventLogModel: Repository<EventLogEntity>;

  @InjectEntityModel(AiUsageLogEntity)
  aiUsageLogModel: Repository<AiUsageLogEntity>;

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
    const limit = trialDailyLimit(project, member);
    if (limit <= 0) throw R.forbiddenError('现场运行是会员功能；示例回放不用开通就能看');
    const now = this.now();
    // 先看全站额度：到顶了不扣这个人的次数
    const spent = Number(await this.redisService.get(trialTokenKey(now))) || 0;
    if (spent + project.tokenEstimate[scenario] > trialTokenLimit()) {
      await this.overBudget(userId, String(body.projectId), scenario, spent);
      throw R.error('今天全站的现场运行额度已用完，明天再来；示例回放随时能看');
    }
    const key = trialQuotaKey(userId, now, String(body.projectId));
    const used = await this.redisService.incr(key);
    if (used === 1) await this.redisService.expire(key, 2 * 86400);
    if (used > limit) {
      await this.denied(userId, String(body.projectId), scenario, 'quota');
      throw R.forbiddenError(`这个项目今天的 ${limit} 次现场运行已用完，明天再来；示例回放随时能看`);
    }

    const exp = Math.floor(now.getTime() / 1000) + TRIAL_TICKET_TTL_SEC;
    const jti = crypto.randomBytes(12).toString('hex');
    await this.redisService.set(
      trialRunKey(jti), JSON.stringify({ userId, project: body.projectId, scenario }), 'EX', TRIAL_RUN_TTL_SEC,
    );
    const ticket = signTrialTicket(
      { jti, exp, project: body.projectId, scenario, cb: trialCallbackBase() },
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
    description: '项目实战在线试用：试用函数开跑前领票据（只认签名，一张只能领一次）',
    functionName: 'projectTrialClaim',
    name: 'projectTrialClaim',
    path: '/project/trial/claim',
    method: 'post',
  })
  @NoAuth()
  async trialClaim(@Body(ALL) body: { token?: string }): Promise<any> {
    const now = this.now();
    const msg = this.openMessage(body, 'claim', now);
    const run = JSON.parse((await this.redisService.get(trialRunKey(msg.jti))) || 'null');
    const project: TrialProject | undefined = TRIAL_PROJECTS[run?.project];
    if (!run || !project) return this.refuse('unknown', '试用票据无效或已过期，请刷新页面重试。');

    const estimate = project.tokenEstimate[run.scenario];
    const dayKey = trialTokenKey(now);
    const won = await this.redisService.set(
      trialClaimKey(msg.jti), JSON.stringify({ dayKey, estimate }), 'EX', TRIAL_RUN_TTL_SEC, 'NX',
    );
    if (!won) return this.refuse('used', '这张试用票据已经用过了，请重新开始。');

    // 先占再看：几张票据同时来领时不会一起冲过上限
    const total = await this.redisService.incrby(dayKey, estimate);
    await this.redisService.expire(dayKey, 2 * 86400);
    if (total > trialTokenLimit()) {
      await this.redisService.incrby(dayKey, -estimate);
      await this.overBudget(run.userId, run.project, run.scenario, total - estimate);
      return this.refuse('budget', '今天全站的现场运行额度已用完，明天再来；示例回放随时能看。');
    }
    return { success: true, data: { ok: true } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '项目实战在线试用：试用函数上报一次运行的实际用量（只认签名，按票据去重）',
    functionName: 'projectTrialUsage',
    name: 'projectTrialUsage',
    path: '/project/trial/usage',
    method: 'post',
  })
  @NoAuth()
  async trialUsage(@Body(ALL) body: { token?: string }): Promise<any> {
    const msg = this.openMessage(body, 'usage', this.now());
    const run = JSON.parse((await this.redisService.get(trialRunKey(msg.jti))) || 'null');
    const claim = JSON.parse((await this.redisService.get(trialClaimKey(msg.jti))) || 'null');
    if (!run || !claim) return this.refuse('unknown', '没有这次运行');
    const first = await this.redisService.set(trialDoneKey(msg.jti), '1', 'EX', TRIAL_RUN_TTL_SEC, 'NX');
    if (!first) return { success: true, data: { ok: true } };

    const inputTokens = Math.round(usageNumber(msg.input_tokens));
    const outputTokens = Math.round(usageNumber(msg.output_tokens));
    const tokens = inputTokens + outputTokens;
    try {
      await this.eventLogModel.save({
        userId: run.userId, event: 'project_trial_run',
        props: {
          project: run.project, scenario: run.scenario, inputTokens, outputTokens,
          calls: usageNumber(msg.calls), estimatedCalls: usageNumber(msg.estimated_calls),
          seconds: usageNumber(msg.seconds), stopped: String(msg.stopped || 'unknown').slice(0, 32),
        },
      });
    } catch (e) {
      await this.redisService.del(trialDoneKey(msg.jti));
      throw e;
    }
    // 明细已经落库，后面两步失败不再让对方重报（会重复记一条）
    await this.redisService.incrby(claim.dayKey, tokens - claim.estimate).catch(() => undefined);
    await this.aiUsageLogModel
      .save({ userId: run.userId, module: `trial:${run.project}`, tokenUsed: tokens, provider: 'deepseek' })
      .catch(() => undefined);
    return { success: true, data: { ok: true } };
  }

  private openMessage(body: { token?: string }, typ: string, now: Date): Record<string, any> {
    const msg = openTrialMessage(
      body?.token, typ, String(process.env.PROJECT_TRIAL_TICKET_SECRET || ''), Math.floor(now.getTime() / 1000),
    );
    if (!msg) throw R.forbiddenError('签名无效');
    return msg;
  }

  private refuse(reason: string, message: string) {
    return { success: true, data: { ok: false, reason, message } };
  }

  /** 记一条拒绝，失败不影响主流程 */
  private async denied(userId: string, project: string, scenario: string, reason: string): Promise<void> {
    try {
      await this.eventLogModel.save({ userId, event: 'project_trial_denied', props: { project, scenario, reason } });
    } catch { /* 埋点失败不阻断 */ }
  }

  private async overBudget(userId: string, project: string, scenario: string, spent: number): Promise<void> {
    await this.denied(userId, project, scenario, 'budget');
    try {
      await this.irisGuard.raise(
        'trial_tokens', '项目实战现场运行：今天的全站 token 额度已用完',
        `今天已用约 ${spent} token，上限 ${trialTokenLimit()}（PROJECT_TRIAL_TOKEN_DAILY）。`
          + '明细查 event_log 里 event=project_trial_run 的记录。',
      );
    } catch { /* 告警失败不阻断 */ }
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '项目实战在线试用：今天还剩几次（只读，不占次数）',
    functionName: 'projectTrialQuota',
    name: 'projectTrialQuota',
    path: '/project/trial/quota',
    method: 'get',
  })
  @NoAuth()
  async trialQuota(@Query('projectId') projectId?: string): Promise<any> {
    const project = TRIAL_PROJECTS[String(projectId || '')];
    if (!project) return { success: true, data: null };
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    // 没登录不算错：页面据此不显示次数
    if (!userId) return { success: true, data: null };
    const member = (await this.entitlementService.check(userId, 'materials_pdf', {})).allowed;
    const limit = trialDailyLimit(project, member);
    const used = Number(await this.redisService.get(trialQuotaKey(userId, this.now(), String(projectId)))) || 0;
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
