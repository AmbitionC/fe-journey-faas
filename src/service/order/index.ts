import { Provide, httpError } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { OrderEntity } from '../../entity/order';

@Provide()
export class OrderService {
  @InjectEntityModel(OrderEntity)
  orderModel: Repository<OrderEntity>;

  /** 旧客户端的自报付款入口已停用。收款核验接入前禁止创建支付成功记录。 */
  async create(p: {
    userId: string;
    type: 'member' | 'pdf';
    name: string;
    amount: number;
    channel?: string;
  }): Promise<void> {
    if (p.type === 'member') throw new httpError.ForbiddenError('会员售卖已暂停，已有权益继续有效');
    throw new httpError.ServiceUnavailableError('资料购买暂未开放：尚未接入真实收款核验');
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
