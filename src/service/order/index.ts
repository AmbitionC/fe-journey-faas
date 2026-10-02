import { Provide, httpError } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { OrderEntity } from '../../entity/order';
import { UserEntity } from '../../entity/user';
import { createHash } from 'crypto';
import { AGENT_PDF_PRODUCT } from '../../common/commerce';

@Provide()
export class OrderService {
  @InjectEntityModel(OrderEntity)
  orderModel: Repository<OrderEntity>;

  /** 旧通用售卖入口保持停用；资料使用固定商品、登录态和幂等的独立入口。 */
  async create(p: {
    userId: string;
    type: 'member' | 'pdf';
    name: string;
    amount: number;
    channel?: string;
  }): Promise<void> {
    if (p.type === 'member') throw new httpError.ForbiddenError('会员售卖已暂停，已有权益继续有效');
    throw new httpError.ServiceUnavailableError('请使用资料页面的单次购买入口');
  }

  private pdfOrderNo(userId: string): string {
    return `PDF-${createHash('sha256').update(`${AGENT_PDF_PRODUCT.sku}:${userId}`).digest('hex')}`;
  }

  /** 锁定既有账号行，跨进程并发/重试仍只产生一笔该商品声明；不修改会员或历史订单。 */
  async reportPdfPurchase(userId: string, channel?: string): Promise<any> {
    if (!userId) throw new httpError.UnauthorizedError('请先登录');
    return this.orderModel.manager.transaction(async manager => {
      const user = await manager.getRepository(UserEntity).findOne({
        where: { phoneNumber: userId }, select: ['id'], lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new httpError.UnauthorizedError('登录账号不存在，请重新登录');
      const repo = manager.getRepository(OrderEntity);
      const where = { userId, orderNo: this.pdfOrderNo(userId), type: 'pdf' };
      const existing = await repo.findOneBy(where);
      if (existing) {
        if (existing.status !== 'self_reported') throw new httpError.ConflictError('该领取记录已失效，请联系管理员');
        return { created: false, order: this.pdfReceipt(existing) };
      }
      const safeChannel = typeof channel === 'string' && /^[\w.-]{1,64}$/.test(channel) ? channel : undefined;
      const order = await repo.save(repo.create({
        ...where, name: AGENT_PDF_PRODUCT.name, amount: AGENT_PDF_PRODUCT.priceCents / 100,
        payTime: new Date(), status: 'self_reported', channel: safeChannel,
      }));
      return { created: true, order: this.pdfReceipt(order) };
    });
  }

  async getPdfPurchase(userId: string): Promise<any> {
    if (!userId) return null;
    const order = await this.orderModel.findOneBy({ userId, orderNo: this.pdfOrderNo(userId), type: 'pdf', status: 'self_reported' });
    return order ? this.pdfReceipt(order) : null;
  }

  private pdfReceipt(order: OrderEntity): any {
    return { orderNo: order.orderNo, name: order.name, amount: Number(order.amount), status: 'self_reported', declaredAt: order.payTime, bankVerified: false };
  }

  async getMemberOrders(userId: string): Promise<any> {
    const records = await this.orderModel.find({
      where: { userId, type: 'member' },
      order: { payTime: 'DESC' },
    });
    return { success: true, data: records };
  }

  async getPdfOrders(userId: string): Promise<any> {
    const records = await this.orderModel.find({
      where: { userId, type: 'pdf' },
      order: { payTime: 'DESC' },
    });
    return { success: true, data: records };
  }
}
