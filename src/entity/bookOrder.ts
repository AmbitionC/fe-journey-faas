import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'book_order' })
export class BookOrderEntity extends BaseEntity {
  @Column({ comment: '用户标识（手机号）' })
  userId: string;

  @Column({ comment: '订单号' })
  orderNo: string;

  @Column({ comment: '书籍 ID' })
  bookId: number;

  @Column({ comment: '书名' })
  bookTitle: string;

  @Column({ comment: '版本类型: pdf / physical' })
  versionType: string;

  @Column({ comment: '金额', type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ comment: '支付时间', nullable: true })
  payTime: Date;

  @Column({ comment: '状态: pending / paid / refunded', default: 'pending' })
  status: string;
}
