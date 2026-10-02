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
import { R } from '../common/base.error.utils';

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
    description: '旧自报付款接口（停用，不开通权益或交付）',
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
    const userId = this.ctx.userInfo?.userId;
    if (!userId) throw R.unauthorizedError('请先登录');
    const type = body?.type === 'member' ? 'member' : 'pdf';
    await this.orderService.create({
      userId,
      type,
      name: '学习资料（PDF，待确认）',
      amount: 9.9,
      channel: body?.channel,
    });
    return { success: true, data: {} };
  }
}
