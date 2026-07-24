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
import { VisitService } from '../service/visit';
import { OrderService } from '../service/order';

@Provide()
export class ProfileHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  visitService: VisitService;

  @Inject()
  orderService: OrderService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '记录用户访问',
    functionName: 'recordVisit',
    name: 'recordVisit',
    path: '/profile/recordVisit',
    method: 'post',
  })
  async recordVisit(@Body(ALL) body: { userId?: string }): Promise<any> {
    const userId = body?.userId || this.ctx.userInfo?.userId;
    return await this.visitService.recordVisit(userId);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取访问统计',
    functionName: 'getVisitStats',
    name: 'getVisitStats',
    path: '/profile/visitStats',
    method: 'get',
  })
  async getVisitStats(@Query('userId') userId: string): Promise<any> {
    return await this.visitService.getVisitStats(userId);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取会员订单',
    functionName: 'getMemberOrders',
    name: 'getMemberOrders',
    path: '/profile/memberOrders',
    method: 'get',
  })
  async getMemberOrders(@Query('userId') userId: string): Promise<any> {
    return await this.orderService.getMemberOrders(userId);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取PDF订单',
    functionName: 'getPdfOrders',
    name: 'getPdfOrders',
    path: '/profile/pdfOrders',
    method: 'get',
  })
  async getPdfOrders(@Query('userId') userId: string): Promise<any> {
    return await this.orderService.getPdfOrders(userId);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '订单落库（自证支付完成后记录，供账单页与增长漏斗）',
    functionName: 'recordOrder',
    name: 'recordOrder',
    path: '/order/record',
    method: 'post',
  })
  async recordOrder(
    @Body(ALL)
    body: {
      userId?: string;
      type?: string;
      name?: string;
      amount?: number;
      channel?: string;
    }
  ): Promise<any> {
    const userId = this.ctx.userInfo?.userId || body?.userId;
    // 未登录不落单（PDF 购买不强制登录），静默成功不阻断交付
    if (!userId) return { success: true, data: null };
    const type = body?.type === 'member' ? 'member' : 'pdf';
    await this.orderService.create({
      userId,
      type,
      name: String(body?.name || '学习资料（PDF）').slice(0, 100),
      amount: Number(body?.amount) || 9.9,
      channel: body?.channel,
    });
    return { success: true, data: {} };
  }
}
