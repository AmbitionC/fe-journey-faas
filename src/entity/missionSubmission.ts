import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 一次做题记录（PRD-02 §4.0 状态机）。
 * claimed → plan_pending → building → submitted → reviewing → passed/rework，任意态可 abandoned。
 */
@Entity({ name: 'mission_submission' })
@Index('idx_msub_user', ['userId'])
@Index('idx_msub_mission', ['missionId'])
export class MissionSubmissionEntity extends BaseEntity {
  @Column({ comment: '用户标识（手机号）', length: 64 })
  userId: string;

  @Column({ comment: '题卡 id', type: 'int' })
  missionId: number;

  @Column({ comment: '题卡 slug（冗余，便于查询）', length: 64, default: '' })
  missionSlug: string;

  @Column({
    comment: '状态: claimed/plan_pending/building/submitted/reviewing/passed/rework/abandoned',
    length: 16,
    default: 'claimed',
  })
  status: string;

  @Column({ comment: '指挥方案（json：{understand,breakdown,firstPrompt}）', type: 'json', nullable: true })
  planDoc: any;

  @Column({ comment: '教练审稿留言/结论', type: 'text', nullable: true })
  planFeedback: string;

  @Column({ comment: '审稿轮数（最多 3 轮，第 3 轮强制放行）', type: 'int', default: 0 })
  planRounds: number;

  @Column({ comment: '交作业 GitHub 仓库链接', length: 255, nullable: true })
  repoUrl: string;

  @Column({ comment: '部署链接（可选）', length: 255, nullable: true })
  deployUrl: string;

  @Column({ comment: '过程复盘三问（json：{strategy,aiFailed,howFixed}）', type: 'json', nullable: true })
  retro: any;

  @Column({ comment: '过程手记（追加式）', type: 'text', nullable: true })
  journal: string;

  @Column({ comment: '返工次数', type: 'int', default: 0 })
  reworkCount: number;

  @Column({ comment: '最近一次评审报告 id（PRD-03 侧保存）', type: 'int', nullable: true })
  latestReviewId: number;

  @Column({ comment: '手把手指南 checkpoint 完成进度（json）', type: 'json', nullable: true })
  guideProgress: any;
}
