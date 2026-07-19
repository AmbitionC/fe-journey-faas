import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/** AI 调用全程记录（PRD-04 F2-1）：可回看输入摘要/召回/工具/耗时/报错。 */
@Entity({ name: 'ai_call_log' })
@Index('idx_aicall_user_time', ['userId', 'createTime'])
@Index('idx_aicall_route', ['route'])
export class AiCallLogEntity extends BaseEntity {
  @Column({ comment: '用户标识', length: 64, nullable: true })
  userId: string;

  @Column({ comment: '模块', length: 32, nullable: true })
  module: string;

  @Column({ comment: '路由/能力 chat|hint|review|grade|generate|coach', length: 32 })
  route: string;

  @Column({ comment: '输入摘要', type: 'text', nullable: true })
  inputSummary: string;

  @Column({ comment: '命中引用', type: 'json', nullable: true })
  retrievedRefs: any;

  @Column({ comment: '耗时 ms', type: 'int', default: 0 })
  latencyMs: number;

  @Column({ comment: 'token 数', type: 'int', default: 0 })
  tokenUsed: number;

  @Column({ comment: '状态 success|error', length: 16, default: 'success' })
  status: string;

  @Column({ comment: '错误信息', type: 'text', nullable: true })
  errorMsg: string;

  // ---- 教练 agentic 可观测扩展（PRD-04 F11；nullable，仅 agentic 链路写） ----
  @Column({ comment: '教练模式 qa|rescue|placement|... ', length: 32, nullable: true })
  mode: string;

  @Column({ comment: 'agentic 循环轮数', type: 'int', nullable: true })
  rounds: number;

  @Column({ comment: '工具调用次数', type: 'int', nullable: true })
  toolCallCount: number;

  @Column({ comment: '兜底触发标记（去重/文本化/空响应/强制终答/参数自纠）', type: 'json', nullable: true })
  fallbackFlags: any;

  @Column({ comment: '成本估算（元）', type: 'float', nullable: true })
  costEstimate: number;
}
