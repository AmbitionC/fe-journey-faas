import {
  Provide,
  Inject,
  ServerlessTrigger,
  ServerlessTriggerType,
  Body,
  Query,
  ALL,
} from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { Context } from '@midwayjs/faas';
import { assertAdmin, resolveUserInfo } from '../common/admin.guard';
import { OperationsService } from '../service/operations';

@Provide()
export class OperationsHTTPService {
  @Inject() ctx: Context;
  @Inject() redisService: RedisService;
  @Inject() operationsService: OperationsService;
  private async actor() {
    await assertAdmin(this.ctx, this.redisService);
    return (await resolveUserInfo(this.ctx, this.redisService))!.userId!;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    functionName: 'operationsList',
    path: '/operations/list',
    method: 'get',
  })
  async list(@Query(ALL) query: any) {
    await this.actor();
    return { success: true, data: await this.operationsService.list(query) };
  }
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    functionName: 'operationsDetail',
    path: '/operations/detail',
    method: 'get',
  })
  async detail(@Query('id') id: string) {
    await this.actor();
    return { success: true, data: await this.operationsService.get(id) };
  }
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    functionName: 'operationsCreate',
    path: '/operations/create',
    method: 'post',
  })
  async create(@Body(ALL) body: any) {
    const actor = await this.actor();
    return {
      success: true,
      data: await this.operationsService.create(body, actor),
    };
  }
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    functionName: 'operationsCommand',
    path: '/operations/command',
    method: 'post',
  })
  async command(@Body(ALL) body: any) {
    const actor = await this.actor();
    return {
      success: true,
      data: await this.operationsService.command(body, actor),
    };
  }
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    functionName: 'operationsUpload',
    path: '/operations/image/upload',
    method: 'post',
  })
  async upload(@Body(ALL) body: any) {
    await this.actor();
    return { success: true, data: await this.operationsService.upload(body) };
  }
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    functionName: 'operationsPreview',
    path: '/operations/image/preview',
    method: 'get',
  })
  async preview(@Query('key') key: string) {
    await this.actor();
    return { success: true, data: this.operationsService.preview(key) };
  }
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    functionName: 'operationsImport',
    path: '/operations/import',
    method: 'post',
  })
  async importContent(@Body(ALL) body: any) {
    const actor = await this.actor();
    return {
      success: true,
      data: await this.operationsService.importContent(body, actor),
    };
  }
}
