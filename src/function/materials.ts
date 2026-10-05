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
import { AGENT_PDF_PRODUCT } from '../common/commerce';
import { OrderService } from '../service/order';

/**
 * 知识点资料（按一级分类 PDF）下载。会员权益：会员校验通过后签发 24h 临时链接。
 * PDF 为 OSS 私有对象，公网直链不可达——只能经此签名链接下载，过期即失效（防泄漏）。
 */
@Provide()
export class MaterialsHTTPService {
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: 'Agent PDF 单次购买商品和已生成清单',
    functionName: 'materialsProduct',
    name: 'materialsProduct',
    path: '/materials/product',
    method: 'get',
  })
  @NoAuth()
  async product(): Promise<any> {
    const [groups, gift] = await Promise.all([
      this.materialsService.groupedListReady(), this.materialsService.legacyGift(),
    ]);
    const purchasingEnabled = groups.some(g => g.items.length > 0);
    return { success: true, data: { ...AGENT_PDF_PRODUCT, groups, purchasingEnabled, gift } };
  }

  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @Inject()
  materialsService: MaterialsService;

  @Inject()
  entitlementService: EntitlementService;

  @Inject()
  orderService: OrderService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前账号的资料领取资格',
    functionName: 'materialsPurchase', name: 'materialsPurchase',
    path: '/materials/purchase', method: 'get',
  })
  @NoAuth()
  async purchaseStatus(): Promise<any> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    const entitlement = await this.entitlementService.check(userId, 'materials_pdf', {});
    if (entitlement.allowed) return { success: true, data: { canDownload: true, basis: 'existing_entitlement' } };
    const order = userId ? await this.orderService.getPdfPurchase(userId) : null;
    return { success: true, data: { canDownload: !!order, basis: order ? 'self_reported' : null, needsLogin: !userId, order } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '记录当前账号的资料支付声明（未核验到账）',
    functionName: 'materialsPurchaseConfirm', name: 'materialsPurchaseConfirm',
    path: '/materials/purchase/confirm', method: 'post',
  })
  @NoAuth()
  async confirmPurchase(@Body(ALL) body: { channel?: string }): Promise<any> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    if (!info?.userId) throw R.unauthorizedError('请先登录后购买资料');
    const entitlement = await this.entitlementService.check(info.userId, 'materials_pdf', {});
    if (entitlement.allowed) return { success: true, data: { created: false, canDownload: true, basis: 'existing_entitlement' } };
    const groups = await this.materialsService.groupedListReady();
    if (!groups.some(g => g.items.length > 0)) throw R.error('资料尚未生成，暂不可购买');
    const result = await this.orderService.reportPdfPurchase(info.userId, body?.channel);
    return { success: true, data: { ...result, canDownload: true, basis: 'self_reported', bankVerified: result.order?.bankVerified === true } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料管理：自报与历史资料订单的人工核实记录',
    functionName: 'materialsAdminPurchases', name: 'materialsAdminPurchases',
    path: '/materials/admin/purchases', method: 'get',
  })
  async adminPurchases(@Query(ALL) query: { take?: number; skip?: number }): Promise<any> {
    await assertAdmin(this.ctx, this.redisService);
    const data = await this.orderService.listPdfPurchases(Number(query?.take ?? 50), Number(query?.skip ?? 0));
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料管理：人工核实到账标记（不影响下载资格）',
    functionName: 'materialsAdminPaymentVerification', name: 'materialsAdminPaymentVerification',
    path: '/materials/admin/payment-verification', method: 'post',
  })
  async adminPaymentVerification(@Body(ALL) body: { orderNo?: string; bankVerified?: boolean }): Promise<any> {
    await assertAdmin(this.ctx, this.redisService);
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const data = await this.orderService.setPdfPaymentVerification(body?.orderNo, body?.bankVerified, info?.userId);
    return { success: true, data };
  }

  /** 会员权益校验（限免期 freeForAll 自动放行）；返回 userId（游客为空串） */
  private async gateMember(): Promise<string> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    const res = await this.entitlementService.check(userId, 'materials_pdf', {});
    if (!res.allowed) {
      const order = userId ? await this.orderService.getPdfPurchase(userId) : null;
      if (!order) throw R.forbiddenError('请先购买资料；已有会员权益继续有效');
    }
    return userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料 PDF 分类清单（已有权益或单次领取）',
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
    description: '取某分类资料的 24h 下载签名链接',
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
