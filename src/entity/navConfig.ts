import { Entity, Column } from 'typeorm';
import { BaseEntity } from './base';

@Entity({ name: 'nav_config' })
export class NavConfigEntity extends BaseEntity {
  @Column({ comment: '模块: interview | knowledge | firstclass', unique: true })
  module: string;

  @Column({ comment: '导航树 JSON 数据', type: 'json' })
  navData: any;

  @Column({ comment: '版本号，用于缓存失效', default: 1 })
  version: number;
}
