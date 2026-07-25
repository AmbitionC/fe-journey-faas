import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { OpsService } from '../service/ops';
import { OpsExecutorService } from '../service/ops/executor';
import { OssService } from '../service/content/oss';
import { resolveUserInfo } from '../common/admin.guard';
import { R } from '../common/base.error.utils';

@Provide()
export class OpsHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  opsService: OpsService;

  @Inject()
  opsExecutorService: OpsExecutorService;

  @Inject()
  ossService: OssService;

  @Inject()
  redisService: RedisService;

  /**
   * 解析登录态。聚合 FaaS 下中间件写入的 ctx.userInfo 不一定透传到本层，
   * 只读 ctx.userInfo 会把已登录管理员误判为未登录 → 前端收 401 后清 token 弹回登录页。
   * 故统一走 resolveUserInfo（ctx.userInfo 快路径 + 请求头 token 反查 Redis 兜底）。
   */
  private async requireLogin(): Promise<string> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId;
    if (!userId) throw R.unauthorizedError('请先登录');
    return userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '对文章做内容体检',
    functionName: 'opsHealthRun',
    name: 'opsHealthRun',
    path: '/ops/health/run',
    method: 'post',
  })
  async healthRun(@Body(ALL) body: { module: string; articleKey: string }) {
    await this.requireLogin();
    const data = await this.opsService.runArticleHealth(body.module, body.articleKey);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '内容健康报告列表',
    functionName: 'opsHealthReports',
    name: 'opsHealthReports',
    path: '/ops/health/reports',
    method: 'get',
  })
  async healthReports(@Query(ALL) query: any) {
    await this.requireLogin();
    const data = await this.opsService.listReports({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      module: query.module,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 运营任务流水',
    functionName: 'opsTasks',
    name: 'opsTasks',
    path: '/ops/tasks',
    method: 'get',
  })
  async tasks(@Query(ALL) query: any) {
    await this.requireLogin();
    const data = await this.opsService.listTasks({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '操作审计列表',
    functionName: 'opsAudit',
    name: 'opsAudit',
    path: '/ops/audit',
    method: 'get',
  })
  async audit(@Query(ALL) query: any) {
    await this.requireLogin();
    const data = await this.opsService.listAudit({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'AI 自动出题→审→自动发布（带熔断/审计/可回滚）',
    functionName: 'opsAutoQuiz',
    name: 'opsAutoQuiz',
    path: '/ops/execute/autoQuiz',
    method: 'post',
  })
  async autoQuiz(@Body(ALL) body: { module: string; articleKey: string }) {
    const userId = await this.requireLogin();
    const data = await this.opsExecutorService.autoQuiz({
      userId,
      module: body.module,
      articleKey: body.articleKey,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '回滚某次自动操作',
    functionName: 'opsRollback',
    name: 'opsRollback',
    path: '/ops/rollback',
    method: 'post',
  })
  async rollback(@Body(ALL) body: { auditId: number }) {
    await this.requireLogin();
    const data = await this.opsExecutorService.rollback(body.auditId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '提交抽检结果',
    functionName: 'opsSampling',
    name: 'opsSampling',
    path: '/ops/sampling/submit',
    method: 'post',
  })
  async sampling(@Body(ALL) body: { taskId?: number; result: string; note?: string }) {
    const sampler = await this.requireLogin();
    const data = await this.opsService.submitSampling({ ...body, sampler });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '群二维码文件状态（过期提醒横幅用）',
    functionName: 'opsGroupQrStatus',
    name: 'opsGroupQrStatus',
    path: '/ops/group-qr/status',
    method: 'get',
  })
  async groupQrStatus() {
    await this.requireLogin();
    const meta = await this.ossService.rawMeta('images/group.jpg');
    if (!meta?.lastModified) {
      return { success: true, data: { exists: false } };
    }
    const updatedAt = new Date(meta.lastModified);
    const staleDays = Math.max(
      0,
      Math.floor((Date.now() - updatedAt.getTime()) / 86400000)
    );
    return {
      success: true,
      data: { exists: true, updatedAt: updatedAt.toISOString(), staleDays },
    };
  }
}
