import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'book' })
export class BookEntity extends BaseEntity {
  @Column({ comment: '书名' })
  title: string;

  @Column({ comment: '作者' })
  author: string;

  @Column({ comment: '封面图 URL', nullable: true })
  coverUrl: string;

  @Column({ comment: '推荐理由', type: 'text' })
  recommendReason: string;

  @Column({ comment: '推荐指数 1-5', type: 'tinyint', default: 3 })
  recommendIndex: number;

  @Column({
    comment: 'PDF 价格',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 2.99,
  })
  pdfPrice: number;

  @Column({
    comment: '纸质版价格',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  physicalPrice: number;

  @Column({ comment: '快团团二维码 URL', nullable: true })
  physicalQrCodeUrl: string;

  @Column({ comment: 'PDF 资源 URL（支付后可见）', nullable: true })
  pdfResourceUrl: string;

  @Column({ comment: '排序权重', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ comment: '状态: active / inactive', default: 'active' })
  status: string;
}
