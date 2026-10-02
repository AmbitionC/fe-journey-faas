import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { BookOrderEntity } from '../../entity/bookOrder';
import { R } from '../../common/base.error.utils';

function generateOrderNo(): string {
  const now = new Date();
  const ts = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `BK${ts}${rand}`;
}

@Provide()
export class BookOrderService {
  @InjectEntityModel(BookOrderEntity)
  bookOrderModel: Repository<BookOrderEntity>;

  async create(data: {
    userId: string;
    bookId: number;
    bookTitle: string;
    versionType: string;
    amount: number;
    channel?: string;
  }): Promise<any> {
    const entity = this.bookOrderModel.create({
      userId: data.userId,
      bookId: data.bookId,
      bookTitle: data.bookTitle,
      versionType: data.versionType,
      amount: data.amount,
      channel: data.channel ? String(data.channel).slice(0, 64) : undefined,
      orderNo: generateOrderNo(),
      status: 'pending',
    });
    const saved = await this.bookOrderModel.save(entity);
    return { success: true, data: saved };
  }

  async confirm(_orderNo: string): Promise<any> {
    throw R.forbiddenError('自报付款确认已停用，请联系站长核实历史收款');
  }

  async getOrders(userId: string): Promise<any> {
    const records = await this.bookOrderModel.find({
      where: { userId },
      order: { createTime: 'DESC' },
    });
    return { success: true, data: records };
  }
}
