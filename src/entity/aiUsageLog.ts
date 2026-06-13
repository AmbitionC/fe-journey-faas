import { Entity, Column, CreateDateColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'ai_usage_log' })
export class AiUsageLogEntity {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ comment: '用户ID' })
  userId: string;

  @Column({ comment: '模块', nullable: true })
  module?: string;

  @Column({ comment: '消耗 token 数', default: 0 })
  tokenUsed: number;

  @Column({ comment: 'LLM 供应商', default: 'qwen' })
  provider: string;

  @CreateDateColumn()
  createTime?: Date;
}
