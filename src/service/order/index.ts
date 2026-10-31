import { Provide, httpError } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { OrderEntity } from '../../entity/order';
import { legacyPdfOrderNo } from '../../common/commerce';

@Provide()
export class OrderService {
  @InjectEntityModel(OrderEntity)
  orderModel: Repository<OrderEntity>;

  /** 旧通用售卖入口保持停用：会员在 Skill 服务页（/developer）开通，PDF 已并入会员权益、不再单卖。 */
  async create(p: {
    userId: string;
    type: 'member' | 'pdf';
    name: string;
    amount: number;
    channel?: string;
  }): Promise<void> {
    if (p.type === 'member') throw new httpError.ForbiddenError('会员请在 Skill 服务页开通，已有权益继续有效');
    throw new httpError.ServiceUnavailableError('知识点 PDF 已并入会员权益，不再单独售卖');
  }

  /**
   * 老 ¥9.9 买家的下载资格（2026-11-01 单卖下架后只读不写）：有效自报与既有 paid 均永久保留，
   * 退款/取消记录不复活。人工核实只是统计标记，不影响资格。
   */
  async getPdfPurchase(userId: string): Promise<any> {
    if (!userId) return null;
    const order = await this.orderModel.findOneBy({ userId, orderNo: legacyPdfOrderNo(userId), type: 'pdf' });
    return order && this.isPdfPurchaseActive(order) ? this.pdfReceipt(order) : null;
  }

  private isPdfPurchaseActive(order: OrderEntity): boolean {
    return order.status === 'self_reported' || order.status === 'paid';
  }

  private pdfReceipt(order: OrderEntity): any {
    return { orderNo: order.orderNo, name: order.name, amount: Number(order.amount), status: order.status, declaredAt: order.payTime, bankVerified: order.bankVerified === true };
  }

  private adminPdfReceipt(order: OrderEntity): any {
    return { ...this.pdfReceipt(order), userId: order.userId, bankVerifiedAt: order.bankVerifiedAt || null, bankVerifiedBy: order.bankVerifiedBy || null };
  }

  /** 管理端读取历史订单核对实际收款；不签发下载链接。 */
  async listPdfPurchases(take = 50, skip = 0): Promise<any[]> {
    if (!Number.isInteger(take) || take < 1 || take > 100 || !Number.isInteger(skip) || skip < 0) {
      throw new httpError.BadRequestError('take 为 1–100 的整数，skip 为非负整数');
    }
    const rows = await this.orderModel.find({ where: { type: 'pdf' }, order: { payTime: 'DESC', id: 'DESC' }, take, skip });
    return rows.map(order => this.adminPdfReceipt(order));
  }

  /** 只能由已认证管理员调用；保留订单状态、金额、归属及已有下载资格。 */
  async setPdfPaymentVerification(orderNo: string, bankVerified: boolean, actor: string): Promise<any> {
    if (typeof orderNo !== 'string' || !orderNo.trim() || orderNo.length > 128 || typeof bankVerified !== 'boolean') {
      throw new httpError.BadRequestError('orderNo 和布尔 bankVerified 必填');
    }
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 128) throw new httpError.UnauthorizedError('需要管理员身份');
    return this.orderModel.manager.transaction(async manager => {
      const repo = manager.getRepository(OrderEntity);
      const order = await repo.findOne({ where: { orderNo, type: 'pdf' }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new httpError.NotFoundError('资料订单不存在');
      if (!this.isPdfPurchaseActive(order)) throw new httpError.ConflictError('退款、取消或无效订单不能核实为有效收款');
      if ((order.bankVerified === true) === bankVerified) return { changed: false, order: this.adminPdfReceipt(order) };
      order.bankVerified = bankVerified;
      order.bankVerifiedAt = bankVerified ? new Date() : null;
      order.bankVerifiedBy = bankVerified ? actor : null;
      const saved = await repo.save(order);
      return { changed: true, order: this.adminPdfReceipt(saved) };
    });
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
    return { success: true, data: records.map(record => {
      const { bankVerifiedBy, ...visible } = record;
      return visible;
    }) };
  }
}
