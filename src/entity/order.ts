import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'order' })
export class OrderEntity extends BaseEntity {
  @Column({ comment: '用户标识（手机号）' })
  userId: string;

  @Column({ comment: '订单号' })
  orderNo: string;

  @Column({ comment: '订单类型: member / pdf' })
  type: string;

  @Column({ comment: '商品名称' })
  name: string;

  @Column({ comment: '金额（元）', type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ comment: '支付时间', nullable: true })
  payTime: Date;

  @Column({ comment: '状态: paid / pending / refunded', default: 'pending' })
  status: string;
}
