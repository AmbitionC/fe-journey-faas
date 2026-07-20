import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * AI 评审报告（PRD-03）。AI 读用户 GitHub 仓库、按题卡验收标准逐条打分。
 * verdict: pass(通过) / rework(返工) / need_human(需人工复核)。
 */
@Entity({ name: 'mission_review' })
@Index('idx_mreview_sub', ['submissionId'])
@Index('idx_mreview_user', ['userId'])
export class MissionReviewEntity extends BaseEntity {
  @Column({ comment: '做题记录 id', type: 'int' })
  submissionId: number;

  @Column({ comment: '题卡 id', type: 'int' })
  missionId: number;

  @Column({ comment: '用户标识', length: 64 })
  userId: string;

  @Column({ comment: '结论: pass / rework / need_human', length: 16 })
  verdict: string;

  @Column({ comment: '总分 0-100', type: 'int', default: 0 })
  totalScore: number;

  @Column({ comment: '分维得分（json：{correctness,process,quality}）', type: 'json', nullable: true })
  scores: any;

  @Column({ comment: '逐条验收判定（json：[{id,text,verdict,note}]）', type: 'json', nullable: true })
  criteriaVerdicts: any;

  @Column({ comment: '评审报告 markdown', type: 'text', nullable: true })
  report: string;

  @Column({ comment: '仓库快照元信息（json：{fileCount,commits,truncated}）', type: 'json', nullable: true })
  repoSnapshot: any;

  @Column({ comment: '补课清单（json：[{module,key,title}]）', type: 'json', nullable: true })
  makeupArticles: any;

  @Column({ comment: '评审模型名', length: 32, nullable: true })
  reviewerModel: string;

  @Column({ comment: '是否已人工复核', default: false })
  humanChecked: boolean;

  @Index('idx_mreview_share', ['shareCode'])
  @Column({ comment: '分享码（通过时生成，公开只读报告用）', length: 32, nullable: true })
  shareCode: string;
}
