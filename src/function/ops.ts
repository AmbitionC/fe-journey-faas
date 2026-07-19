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
import { OpsService } from '../service/ops';
import { OpsExecutorService } from '../service/ops/executor';
import { OssService } from '../service/content/oss';
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

  private requireLogin() {
    const userId = this.ctx.userInfo?.userId;
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    this.requireLogin();
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
    const userId = this.requireLogin();
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
    this.requireLogin();
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
    const sampler = this.requireLogin();
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
    this.requireLogin();
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
