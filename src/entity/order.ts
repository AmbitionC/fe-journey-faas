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

  @Column({ comment: '状态: self_reported / paid / pending / refunded / cancelled', default: 'pending' })
  status: string;

  @Column({ comment: '人工核实到账；不作为资料下载门槛', default: false })
  bankVerified: boolean;

  @Column({ comment: '人工核实到账时间', type: 'datetime', nullable: true })
  bankVerifiedAt: Date;

  @Column({ comment: '执行人工核实的管理员标识', length: 128, nullable: true })
  bankVerifiedBy: string;

  @Column({ comment: '首触渠道归因(如 xhs-note0715)', length: 64, nullable: true })
  channel: string;
}
