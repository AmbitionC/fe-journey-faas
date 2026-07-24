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
import { NoAuth } from '../decorator/noAuth';
import { MaterialsService } from '../service/materials';
import { EntitlementService } from '../service/entitlement';
import { resolveUserInfo, assertAdmin } from '../common/admin.guard';
import { R } from '../common/base.error.utils';

/**
 * 知识点资料（按一级分类 PDF）下载。会员权益：会员校验通过后签发 24h 临时链接。
 * PDF 为 OSS 私有对象，公网直链不可达——只能经此签名链接下载，过期即失效（防泄漏）。
 */
@Provide()
export class MaterialsHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  materialsService: MaterialsService;

  @Inject()
  entitlementService: EntitlementService;

  /** 会员权益校验（限免期 freeForAll 自动放行）；返回 userId（游客为空串） */
  private async gateMember(): Promise<string> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    const res = await this.entitlementService.check(userId, 'materials_pdf', {});
    if (!res.allowed) {
      throw R.forbiddenError(res.reason || 'ENTITLEMENT:materials_pdf:member_only');
    }
    return userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料 PDF 分类清单（会员）',
    functionName: 'materialsList',
    name: 'materialsList',
    path: '/materials/list',
    method: 'get',
  })
  @NoAuth()
  async list(): Promise<any> {
    await this.gateMember();
    const data = await this.materialsService.groupedListReady();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '取某分类资料的 24h 下载签名链接（会员）',
    functionName: 'materialsDownload',
    name: 'materialsDownload',
    path: '/materials/download',
    method: 'get',
  })
  @NoAuth()
  async download(@Query('category') category: string): Promise<any> {
    await this.gateMember();
    if (!category) throw R.error('category 必填');
    if (!(await this.materialsService.isReady(category))) {
      throw R.error('该分类资料尚未生成');
    }
    const url = await this.materialsService.downloadUrl(category);
    return { success: true, data: { url, expiresInSec: 86400 } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料管理：全部分类及生成状态（管理端）',
    functionName: 'materialsAdminList',
    name: 'materialsAdminList',
    path: '/materials/admin/list',
    method: 'get',
  })
  async adminList(): Promise<any> {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.materialsService.groupedList();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料管理：取某分类下载签名链接自测（管理端）',
    functionName: 'materialsAdminDownload',
    name: 'materialsAdminDownload',
    path: '/materials/admin/download',
    method: 'get',
  })
  async adminDownload(@Query('category') category: string): Promise<any> {
    await assertAdmin(this.ctx, this.redisService);
    if (!category) throw R.error('category 必填');
    if (!(await this.materialsService.isReady(category))) {
      throw R.error('该分类资料尚未生成');
    }
    const url = await this.materialsService.downloadUrl(category);
    return { success: true, data: { url, expiresInSec: 86400 } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料管理：手动上传/替换某分类 PDF（管理端）',
    functionName: 'materialsAdminUpload',
    name: 'materialsAdminUpload',
    path: '/materials/admin/upload',
    method: 'post',
  })
  async adminUpload(
    @Body(ALL) body: { category?: string; dataBase64?: string }
  ): Promise<any> {
    await assertAdmin(this.ctx, this.redisService);
    if (!body?.category || !body?.dataBase64) {
      throw R.error('category / dataBase64 必填');
    }
    const base64 = body.dataBase64.includes(',')
      ? body.dataBase64.split(',')[1]
      : body.dataBase64;
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length) throw R.error('文件内容为空');
    const item = await this.materialsService.adminUpload(body.category, buf);
    return { success: true, data: item };
  }
}
