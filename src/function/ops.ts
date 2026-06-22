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
import { R } from '../common/base.error.utils';

@Provide()
export class OpsHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  opsService: OpsService;

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
}
