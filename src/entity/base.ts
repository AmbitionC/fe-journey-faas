import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export class BaseEntity {
  @PrimaryGeneratedColumn()
  id?: string;

  @CreateDateColumn()
  createTime?: Date;

  @UpdateDateColumn()
  updateTime?: Date;

  toVO?(): any {
    return this;
  }
}
