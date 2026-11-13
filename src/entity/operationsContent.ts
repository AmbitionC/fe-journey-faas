import { Entity, Column, PrimaryColumn } from 'typeorm';
import { Document, Status } from '../service/operations/model';

@Entity({ name: 'operations_content' })
export class OperationsContentEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id: string;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 40 }) platform: string;
  @Column({ type: 'varchar', length: 24 }) status: Status;
  @Column({ type: 'int', unsigned: true }) revision: number;
  @Column({ type: 'json' }) document: Document;
  @Column({ type: 'varchar', length: 30 }) updatedAt: string;
}
