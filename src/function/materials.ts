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
import { PDF_MEMBER_BENEFIT, PdfAccessBasis, pdfFreeClaimActive } from '../common/commerce';
import { OrderService } from '../service/order';
import { SKUS, currentPhase, phasePrice } from '../mcp/billing';

interface PdfAccess {
  userId: string;
  canDownload: boolean;
  basis: PdfAccessBasis | null;
  needsLogin: boolean;
  /** 老 ¥9.9 订单回执（仅 basis=legacy_purchase） */
  order: any | null;
}

/**
 * 知识点资料（按知识库二级分类的 PDF）下载。
 * 2026-11-01 起是会员权益（¥9.9 单卖下架）：会员权益 → 老 ¥9.9 买家 → 公测免费期已登录，三者之一即签发 24h 临时链接。
 * PDF 为 OSS 私有对象，公网直链不可达——只能经此签名链接下载，过期即失效（防泄漏）。
 */
@Provide()
export class MaterialsHTTPService {
  /** 当前时间（决定公测免费期）；单测注入 */
  now: () => Date = () => new Date();

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '知识点 PDF 会员权益说明、会员价与已生成清单',
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
    const now = this.now();
    const phase = currentPhase(now);
    const freeClaim = pdfFreeClaimActive(now);
    // 会员价只从 mcp/billing 读（与 /mcp/pricing 同源），这里不写死数字
    const plans = SKUS.filter(s => s.kind === 'plan').map(s => ({
      sku: s.sku, name: s.name, months: s.months || 1,
      listPrice: s.listCents / 100, price: phasePrice(s, phase.id) / 100,
      purchasable: phase.id !== 'free',
    }));
    const message = freeClaim
      ? '公测期登录即可领取全部 PDF；12 月 1 日起仅会员可下载，现在开通会员享早期用户半价。'
      : '开通会员即可下载全部 PDF；已购 ¥9.9 资料的用户继续可下载。';
    return {
      success: true,
      data: {
        ...PDF_MEMBER_BENEFIT,
        groups, gift,
        ready: groups.some(g => g.items.length > 0),
        // 老前端据此隐藏付款按钮：单卖已下架，永远为 false
        purchasingEnabled: false,
        membership: { phase: { id: phase.id, name: phase.name, next: phase.next }, plans, freeClaim },
        message,
      },
    };
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

  /** 下载资格：会员权益（网站存量会员 / Skill 会员）→ 老 ¥9.9 买家 → 公测免费期已登录 → 拒绝 */
  private async pdfAccess(): Promise<PdfAccess> {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    const userId = info?.userId || '';
    const denied: PdfAccess = { userId, canDownload: false, basis: null, needsLogin: !userId, order: null };
    if (!userId) return denied;
    const entitlement = await this.entitlementService.check(userId, 'materials_pdf', {});
    if (entitlement.allowed) return { ...denied, canDownload: true, basis: 'member' };
    const order = await this.orderService.getPdfPurchase(userId);
    if (order) return { ...denied, canDownload: true, basis: 'legacy_purchase', order };
    if (pdfFreeClaimActive(this.now())) return { ...denied, canDownload: true, basis: 'free_phase' };
    return denied;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '当前账号的资料领取资格',
    functionName: 'materialsPurchase', name: 'materialsPurchase',
    path: '/materials/purchase', method: 'get',
  })
  @NoAuth()
  async purchaseStatus(): Promise<any> {
    const { userId, ...access } = await this.pdfAccess();
    return { success: true, data: { ...access, saleClosed: true, memberUrl: PDF_MEMBER_BENEFIT.memberUrl } };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '旧「我已支付」接口：¥9.9 单卖已下架，不再写自报订单；已有资格的照常返回可下载',
    functionName: 'materialsPurchaseConfirm', name: 'materialsPurchaseConfirm',
    path: '/materials/purchase/confirm', method: 'post',
  })
  @NoAuth()
  async confirmPurchase(@Body(ALL) _body: { channel?: string }): Promise<any> {
    const access = await this.pdfAccess();
    if (access.needsLogin) throw R.unauthorizedError('请先登录');
    if (access.canDownload) {
      return { success: true, data: { created: false, canDownload: true, basis: access.basis, order: access.order, bankVerified: access.order?.bankVerified === true } };
    }
    throw R.error('知识点 PDF 已并入会员权益，不再单独售卖；请勿转账，开通会员后即可领取');
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料管理：历史 ¥9.9 自报订单的人工核实记录',
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

  /** 资格校验；返回 userId（游客为空串） */
  private async gateMember(): Promise<string> {
    const access = await this.pdfAccess();
    if (!access.canDownload) {
      if (access.needsLogin) throw R.unauthorizedError('请先登录后领取');
      throw R.forbiddenError('知识点 PDF 为会员权益，请先开通会员；已购资料与已有会员权益继续有效');
    }
    return access.userId;
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '资料 PDF 分类清单（会员 / 老买家 / 公测期）',
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
