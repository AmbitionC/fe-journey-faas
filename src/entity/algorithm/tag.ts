import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base';

@Entity({ name: 'algorithm_tag' })
export class AlgorithmTagEntity extends BaseEntity {
  @Index('idx_tag_name', { unique: true })
  @Column({ comment: '标签名', length: 50 })
  name: string;
}
