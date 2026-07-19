import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base';

/**
 * 题卡（PRD-02 §5）：一道真项目题的微型 PRD。
 * 题库按「前端转 Agent」进阶顺序组织（sortOrder 即一条路上的位置，学习计划按它挂周）。
 */
@Entity({ name: 'mission' })
export class MissionEntity extends BaseEntity {
  @Index('uniq_mission_slug', { unique: true })
  @Column({ comment: '题卡标识 slug，如 anti-spam-comments；学习计划按 slug 引用（PRD-01）', length: 64 })
  slug: string;

  @Column({ comment: '标题', length: 128 })
  title: string;

  @Column({ comment: '档位: small(⚡) / medium(🔨) / large(🏔)', length: 16, default: 'small' })
  tier: string;

  @Column({ comment: '预估时长文案，如「2-4 小时」', length: 32, default: '' })
  estimate: string;

  @Column({ comment: '难度 1-3', type: 'int', default: 1 })
  difficulty: number;

  @Column({ comment: '一句话简介', length: 255, default: '' })
  summary: string;

  @Column({ comment: '业务背景 markdown', type: 'text', nullable: true })
  background: string;

  @Column({ comment: '需求列表（json 字符串数组）', type: 'json', nullable: true })
  requirements: any;

  @Column({ comment: '约束（json 字符串数组）', type: 'json', nullable: true })
  constraints: any;

  @Column({
    comment: '验收标准（json：[{id,text,weight?,mustPass?,autoCheckable?}]），评审逐条打分',
    type: 'json',
    nullable: true,
  })
  acceptanceCriteria: any;

  @Column({ comment: '前置知识（json：[{module,key,title}]）', type: 'json', nullable: true })
  prereqArticles: any;

  @Column({ comment: '在一条路上的顺序，学习计划按此挂周（PRD-01）', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ comment: '状态: draft / published / offline', length: 16, default: 'draft' })
  status: string;

  @Column({ comment: '是否推荐项目（guided=true 组成 offer 作品集路线，PRD-02 F12）', default: false })
  guided: boolean;

  @Column({ comment: '手把手指南步数（列表展示「N 步带练」）', type: 'int', default: 0 })
  guideCheckpoints: number;

  @Column({ comment: '是否免费可做（保留字段，当前单轨制不启用）', default: false })
  freeAccess: boolean;
}
