import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { OrderEntity } from '../../entity/order';

@Provide()
export class OrderService {
  @InjectEntityModel(OrderEntity)
  orderModel: Repository<OrderEntity>;

  /**
   * 订单落库（账单页与增长漏斗的数据源）。
   * 支付本身是「收款码 + 手动确认」无网关，因此 status 直接记 paid，语义是"用户自证已付"。
   */
  async create(p: {
    userId: string;
    type: 'member' | 'pdf';
    name: string;
    amount: number;
    channel?: string;
  }): Promise<void> {
    const orderNo = `FJ${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
    await this.orderModel.save(
      this.orderModel.create({
        userId: p.userId,
        orderNo,
        type: p.type,
        name: p.name,
        amount: p.amount,
        payTime: new Date(),
        status: 'paid',
        channel: p.channel ? String(p.channel).slice(0, 64) : null,
      })
    );
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
