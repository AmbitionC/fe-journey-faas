import { Provide, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository, In } from 'typeorm';
import { CohortEntity } from '../../entity/cohort';
import { CohortMemberEntity } from '../../entity/cohortMember';
import { CohortPostEntity } from '../../entity/cohortPost';
import { MissionSubmissionEntity } from '../../entity/missionSubmission';
import { MissionEntity } from '../../entity/mission';
import { R } from '../../common/base.error.utils';

/** 里程碑顺序（进度榜格子图用）。 */
const MILESTONES = ['claimed', 'plan', 'building', 'submitted', 'passed'];

/** 里程碑：领题(1)→方案(2)→开发(3)→交付(4)→通过(5)。返回已完成的里程碑数。 */
function statusToMilestone(status: string): number {
  switch (status) {
    case 'claimed':
    case 'plan_pending':
      return 1; // 领题
    case 'building':
      return 2; // 方案已过，开发中
    case 'rework':
      return 3; // 交付过、返工中（开发完成）
    case 'submitted':
    case 'reviewing':
      return 4; // 已交付，评审中
    case 'passed':
      return 5; // 通过
    default:
      return 0;
  }
}

/**
 * 同期挑战服务（PRD-06）。进度榜纯服务端统计（零 AI/零审核）；
 * 运营内容由站长外部 skill 起草，系统只做数据出口 + 发布接口。
 */
@Provide()
export class CohortService {
  @InjectEntityModel(CohortEntity)
  cohortModel: Repository<CohortEntity>;

  @InjectEntityModel(CohortMemberEntity)
  memberModel: Repository<CohortMemberEntity>;

  @InjectEntityModel(CohortPostEntity)
  postModel: Repository<CohortPostEntity>;

  @InjectEntityModel(MissionSubmissionEntity)
  submissionModel: Repository<MissionSubmissionEntity>;

  @InjectEntityModel(MissionEntity)
  missionModel: Repository<MissionEntity>;

  @Config('journey')
  journeyConfig: { cohortEnabled: boolean };

  private ensureEnabled(): void {
    if (!this.journeyConfig?.cohortEnabled) throw R.error('同期挑战功能尚未开放');
  }

  /** 当前期次（active 优先，其次最近 upcoming）。 */
  async current(): Promise<CohortEntity | null> {
    this.ensureEnabled();
    const active = await this.cohortModel.findOne({ where: { status: 'active' }, order: { startAt: 'DESC' } });
    if (active) return active;
    return this.cohortModel.findOne({ where: { status: 'upcoming' }, order: { startAt: 'ASC' } });
  }

  /** 报名加入。 */
  async join(userId: string, slug: string, nickName: string, anonymous?: boolean): Promise<any> {
    this.ensureEnabled();
    if (!userId || userId.startsWith('guest:')) throw R.unauthorizedError('请先登录');
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort || cohort.status === 'ended') throw R.error('期次不存在或已结束');
    const existing = await this.memberModel.findOne({ where: { cohortId: Number(cohort.id), userId } });
    if (existing) return existing;
    return this.memberModel.save(
      this.memberModel.create({
        cohortId: Number(cohort.id),
        userId,
        nickName: nickName || '学员',
        anonymous: !!anonymous,
        progress: null,
      })
    );
  }

  /** 进度榜（纯统计）：各成员在期次主题上的里程碑进度 + 格子图。 */
  async leaderboard(slug: string): Promise<any> {
    this.ensureEnabled();
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort) throw R.error('期次不存在');
    const members = await this.memberModel.find({ where: { cohortId: Number(cohort.id) } });
    if (!members.length) return { cohort: cohort.title, milestones: MILESTONES, rows: [], memberCount: 0 };

    const mission = cohort.missionSlug
      ? await this.missionModel.findOne({ where: { slug: cohort.missionSlug } })
      : null;
    const userIds = members.map((m) => m.userId);
    let subs: MissionSubmissionEntity[] = [];
    if (mission) {
      subs = await this.submissionModel.find({
        where: { missionId: Number(mission.id), userId: In(userIds) },
      });
    }
    const subByUser = new Map(subs.map((s) => [s.userId, s]));

    const rows = members
      .map((m) => {
        const sub = subByUser.get(m.userId);
        const milestone = sub ? statusToMilestone(sub.status) : 0;
        return {
          name: m.anonymous ? '匿名学员' : m.nickName || '学员',
          milestone,
          grid: MILESTONES.map((_, i) => i < milestone),
          passed: milestone >= 5,
        };
      })
      .sort((a, b) => b.milestone - a.milestone);

    return {
      cohort: cohort.title,
      mission: mission?.title || '',
      milestones: MILESTONES,
      memberCount: members.length,
      passedCount: rows.filter((r) => r.passed).length,
      rows,
    };
  }

  /** 里程碑打卡（PRD-06 F2）：成员自报"我到这步了"。客观进度仍以做题评审为准（进度榜）。 */
  async checkinMilestone(userId: string, slug: string, milestone: string): Promise<any> {
    this.ensureEnabled();
    const member = await this.requireMember(userId, slug);
    const checks = (member.milestoneChecks && typeof member.milestoneChecks === 'object') ? member.milestoneChecks : {};
    checks[milestone] = Date.now();
    member.milestoneChecks = checks;
    await this.memberModel.save(member);
    return { milestoneChecks: checks };
  }

  /** 提交结营展示物 + 是否上作品墙（PRD-06 F3/F4）。 */
  async submitShowcase(
    userId: string,
    slug: string,
    data: { title?: string; content?: string; repoUrl?: string; deployUrl?: string; wallOptIn?: boolean }
  ): Promise<any> {
    this.ensureEnabled();
    const member = await this.requireMember(userId, slug);
    member.showcase = {
      title: (data.title || '').slice(0, 128),
      content: (data.content || '').slice(0, 4000),
      repoUrl: (data.repoUrl || '').slice(0, 255),
      deployUrl: (data.deployUrl || '').slice(0, 255),
    };
    if (typeof data.wallOptIn === 'boolean') member.wallOptIn = data.wallOptIn;
    await this.memberModel.save(member);
    return { showcase: member.showcase, wallOptIn: member.wallOptIn };
  }

  /** 作品墙（PRD-06 F4）：展示同意上墙的结营展示物，通过大题者优先。 */
  async getWall(slug: string): Promise<any> {
    this.ensureEnabled();
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort) throw R.error('期次不存在');
    const members = await this.memberModel.find({ where: { cohortId: Number(cohort.id), wallOptIn: true } });
    const withShowcase = members.filter((m) => m.showcase && (m.showcase.title || m.showcase.content));
    return withShowcase
      .map((m) => ({
        name: m.anonymous ? '匿名学员' : m.nickName || '学员',
        completion: m.completion,
        showcase: m.showcase,
      }))
      .sort((a, b) => Number(b.completion) - Number(a.completion));
  }

  /** 本人在本期的状态（打卡/展示/结营徽章）。 */
  async myStatus(userId: string, slug: string): Promise<any> {
    this.ensureEnabled();
    if (!userId || userId.startsWith('guest:')) return null;
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort) return null;
    const member = await this.memberModel.findOne({ where: { cohortId: Number(cohort.id), userId } });
    if (!member) return { joined: false };
    // 结营徽章：通过当期大题即得（客观，评审判定）
    let completion = member.completion;
    if (!completion && cohort.missionSlug) {
      const mission = await this.missionModel.findOne({ where: { slug: cohort.missionSlug } });
      if (mission) {
        const passed = await this.submissionModel.findOne({
          where: { userId, missionId: Number(mission.id), status: 'passed' as any },
        });
        if (passed) {
          member.completion = true;
          completion = true;
          await this.memberModel.save(member);
        }
      }
    }
    return {
      joined: true,
      milestoneChecks: member.milestoneChecks || {},
      showcase: member.showcase || null,
      wallOptIn: member.wallOptIn,
      completion,
    };
  }

  /** 我的结营徽章清单（作品档案联动，PRD-06 F6）。 */
  async myBadges(userId: string): Promise<any> {
    if (!userId || userId.startsWith('guest:')) return [];
    const members = await this.memberModel.find({ where: { userId, completion: true } });
    const cohortIds = members.map((m) => m.cohortId);
    if (!cohortIds.length) return [];
    const cohorts = await this.cohortModel.find({ where: { id: In(cohortIds as any) } });
    return cohorts.map((c) => ({ slug: c.slug, title: c.title }));
  }

  /** 取本人在某期的成员记录，未报名则抛错。 */
  private async requireMember(userId: string, slug: string): Promise<CohortMemberEntity> {
    if (!userId || userId.startsWith('guest:')) throw R.unauthorizedError('请先登录');
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort) throw R.error('期次不存在');
    const member = await this.memberModel.findOne({ where: { cohortId: Number(cohort.id), userId } });
    if (!member) throw R.error('请先报名加入本期');
    return member;
  }

  /** 期次已发布内容。 */
  async posts(slug: string): Promise<any> {
    this.ensureEnabled();
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort) return [];
    return this.postModel.find({ where: { cohortId: Number(cohort.id) }, order: { createTime: 'DESC' } });
  }

  // ---- 运营数据出口 + 发布接口（管理员） ----

  /**
   * 数据出口（PRD-06 F5）：本期整体进度 + 脱敏共性卡点摘要。
   * 站长外部 skill 据此起草周报（系统不写文案）。
   */
  async weeklyData(slug: string): Promise<any> {
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort) throw R.error('期次不存在');
    const members = await this.memberModel.find({ where: { cohortId: Number(cohort.id) } });
    const mission = cohort.missionSlug
      ? await this.missionModel.findOne({ where: { slug: cohort.missionSlug } })
      : null;

    const dist: Record<string, number> = { notStarted: 0, building: 0, submitted: 0, passed: 0 };
    if (mission && members.length) {
      const subs = await this.submissionModel.find({
        where: { missionId: Number(mission.id), userId: In(members.map((m) => m.userId)) },
      });
      const byUser = new Map(subs.map((s) => [s.userId, s]));
      for (const m of members) {
        const s = byUser.get(m.userId);
        const ms = s ? statusToMilestone(s.status) : 0;
        if (ms >= 5) dist.passed++;
        else if (ms >= 4) dist.submitted++;
        else if (ms >= 2) dist.building++; // 方案已过、真正在做（仅领题不算"building"）
        else dist.notStarted++;
      }
    }

    return {
      cohort: cohort.title,
      mission: mission?.title || '',
      memberCount: members.length,
      progressDistribution: dist,
      // 脱敏共性卡点：交由外部 skill 结合急救日志聚类；系统这里只给进度出口，
      // 卡点摘要如需可另接 aiCallLog(mode=rescue) 聚合（避免个人信息，本期先不下发原文）。
      note: '卡点共性摘要请用外部 skill 结合急救日志脱敏聚类；本出口只提供进度分布，不含个人原文。',
    };
  }

  /** 幂等发布（PRD-06 F5）：同 idemKey 重复发布不重复建。 */
  async publish(slug: string, data: { idemKey: string; title?: string; content: string }): Promise<any> {
    const cohort = await this.cohortModel.findOne({ where: { slug } });
    if (!cohort) throw R.error('期次不存在');
    if (!data.idemKey || !data.content) throw R.error('idemKey 与 content 必填');
    const existing = await this.postModel.findOne({
      where: { cohortId: Number(cohort.id), idemKey: data.idemKey },
    });
    if (existing) {
      existing.title = data.title || existing.title;
      existing.content = data.content;
      return this.postModel.save(existing);
    }
    return this.postModel.save(
      this.postModel.create({
        cohortId: Number(cohort.id),
        idemKey: data.idemKey,
        title: data.title || '',
        content: data.content,
      })
    );
  }

  // ---- manager 期次管理 ----

  async manageList(): Promise<any> {
    return this.cohortModel.find({ order: { startAt: 'DESC' } });
  }

  async manageSave(data: Partial<CohortEntity> & { slug: string }): Promise<any> {
    if (!data.slug) throw R.error('slug 必填');
    const existing = await this.cohortModel.findOne({ where: { slug: data.slug } });
    if (existing) {
      Object.assign(existing, data);
      return this.cohortModel.save(existing);
    }
    return this.cohortModel.save(this.cohortModel.create({ status: 'upcoming', ...data }));
  }

  async manageStatus(slug: string, status: 'upcoming' | 'active' | 'ended'): Promise<any> {
    const c = await this.cohortModel.findOne({ where: { slug } });
    if (!c) throw R.error('期次不存在');
    c.status = status;
    return this.cohortModel.save(c);
  }
}
