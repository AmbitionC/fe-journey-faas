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

function statusToMilestone(status: string): number {
  switch (status) {
    case 'claimed':
      return 1;
    case 'plan_pending':
      return 1;
    case 'building':
      return 3;
    case 'submitted':
    case 'reviewing':
    case 'rework':
      return 4;
    case 'passed':
      return 5;
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
        else if (ms >= 1) dist.building++;
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
