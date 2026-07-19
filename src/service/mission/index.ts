import { Provide, Inject, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository, In } from 'typeorm';
import fetch from 'node-fetch';
import { MissionEntity } from '../../entity/mission';
import { MissionSubmissionEntity } from '../../entity/missionSubmission';
import { EntitlementService } from '../entitlement';
import { AiProxyService } from '../ai/proxy';
import { R } from '../../common/base.error.utils';

/** 进行中（未完结）状态集合。 */
const IN_PROGRESS = ['claimed', 'plan_pending', 'building', 'submitted', 'reviewing', 'rework'];
const MAX_IN_PROGRESS = 2;

/**
 * 做题闭环服务（PRD-02）。题卡体系 + 领题→先想后做→开干→交作业的状态机。
 * 评审（submitted→reviewing→passed/rework）由 PRD-03 ReviewService 回写，本服务只消费结果。
 */
@Provide()
export class MissionService {
  @InjectEntityModel(MissionEntity)
  missionModel: Repository<MissionEntity>;

  @InjectEntityModel(MissionSubmissionEntity)
  submissionModel: Repository<MissionSubmissionEntity>;

  @Inject()
  entitlementService: EntitlementService;

  @Inject()
  aiProxyService: AiProxyService;

  @Config('journey')
  journeyConfig: { missionEnabled: boolean };

  private ensureEnabled(): void {
    if (!this.journeyConfig?.missionEnabled) {
      throw R.error('做题功能尚未开放');
    }
  }

  /** 题卡详情 + 当前用户的做题状态。 */
  async detail(slug: string, userId: string): Promise<any> {
    this.ensureEnabled();
    const mission = await this.missionModel.findOne({ where: { slug } });
    if (!mission || mission.status === 'draft') throw R.error('题卡不存在');
    let submission: MissionSubmissionEntity | null = null;
    if (userId && !userId.startsWith('guest:')) {
      submission = await this.submissionModel.findOne({
        where: { userId, missionId: Number(mission.id), status: In([...IN_PROGRESS, 'passed']) },
        order: { createTime: 'DESC' },
      });
    }
    return { mission, submission };
  }

  /** 题库列表（已发布）+ 锁态。 */
  async list(tier: string | undefined, userId: string, isMember: boolean): Promise<any> {
    this.ensureEnabled();
    const where: any = { status: 'published' };
    if (tier) where.tier = tier;
    const missions = await this.missionModel.find({ where, order: { sortOrder: 'ASC' } });
    // 领题是会员/试用权益；锁态供前端渲染（题库全貌是转化素材）
    const locked = !isMember;
    return missions.map((m) => ({
      slug: m.slug,
      title: m.title,
      tier: m.tier,
      estimate: m.estimate,
      difficulty: m.difficulty,
      summary: m.summary,
      guided: m.guided,
      guideCheckpoints: m.guideCheckpoints,
      sortOrder: m.sortOrder,
      locked,
    }));
  }

  /** 领题：创建 submission（会员/试用权益，在途 ≤2，同题只允许一条进行中）。 */
  async claim(userId: string, slug: string, isMember: boolean): Promise<any> {
    this.ensureEnabled();
    if (!userId || userId.startsWith('guest:')) throw R.unauthorizedError('请先登录');
    const check = await this.entitlementService.check(userId, 'mission_access', {
      isMember,
      consume: false,
    });
    if (!check.allowed) throw R.forbiddenError(check.reason || 'ENTITLEMENT:mission_access:member_only');

    const mission = await this.missionModel.findOne({ where: { slug } });
    if (!mission || mission.status !== 'published') throw R.error('题卡不存在或未发布');

    // 同题已有进行中/通过记录则返回它
    const existing = await this.submissionModel.findOne({
      where: { userId, missionId: Number(mission.id), status: In([...IN_PROGRESS, 'passed']) },
      order: { createTime: 'DESC' },
    });
    if (existing) return existing;

    // 防囤题：进行中 ≤ 2
    const inProgressCount = await this.submissionModel.count({
      where: { userId, status: In(IN_PROGRESS) },
    });
    if (inProgressCount >= MAX_IN_PROGRESS) {
      throw R.error(`进行中的题不能超过 ${MAX_IN_PROGRESS} 道，先完成或放弃一道`);
    }

    return this.submissionModel.save(
      this.submissionModel.create({
        userId,
        missionId: Number(mission.id),
        missionSlug: mission.slug,
        status: 'claimed',
        planRounds: 0,
        reworkCount: 0,
      })
    );
  }

  /**
   * 先想后做：提交指挥方案（MVP 降级版——提交即通过 building + 异步教练留言）。
   * 三栏均必填、每栏 ≥50 字。审稿硬门槛由 PRD-04 plan_review 模式承接（本 MVP 不拦）。
   */
  async submitPlan(
    userId: string,
    submissionId: number,
    planDoc: { understand?: string; breakdown?: string; firstPrompt?: string }
  ): Promise<any> {
    this.ensureEnabled();
    const sub = await this.mySubmission(userId, submissionId);
    if (!['claimed', 'plan_pending'].includes(sub.status)) {
      throw R.error('当前状态不能提交指挥方案');
    }
    const { understand, breakdown, firstPrompt } = planDoc || {};
    for (const [k, v] of [
      ['需求理解', understand],
      ['任务拆解', breakdown],
      ['初始指令', firstPrompt],
    ] as const) {
      if (!v || v.trim().length < 50) throw R.error(`「${k}」至少写 50 字`);
    }
    sub.planDoc = { understand, breakdown, firstPrompt };
    sub.status = 'building';
    sub.planRounds = (sub.planRounds || 0) + 1;
    await this.submissionModel.save(sub);

    // 异步教练留言（best-effort，失败静默降级）
    this.generatePlanFeedback(sub.id as any, planDoc).catch(() => {});
    return sub;
  }

  private async generatePlanFeedback(submissionId: number, planDoc: any): Promise<void> {
    try {
      const system =
        '你是严格但友善的项目教练。用户提交了做一道真实项目题前的「指挥方案」（需求理解/任务拆解/给AI的初始指令）。' +
        '请指出其中最值得再想清楚的 1-2 个点（用提问的方式点醒，不要代写方案、不要给代码）。50-120 字，中文。';
      const user = `需求理解：${planDoc.understand}\n任务拆解：${planDoc.breakdown}\n初始指令：${planDoc.firstPrompt}`;
      const feedback = await this.aiProxyService.completeRaw(system, user, 'coach-plan');
      if (feedback) {
        await this.submissionModel.update({ id: submissionId as any }, { planFeedback: feedback.trim().slice(0, 800) });
      }
    } catch {
      /* 留言失败不影响流程 */
    }
  }

  /** 交作业：GitHub 仓库链接 + 三问复盘 → submitted（评审由 PRD-03 触发）。 */
  async submitWork(
    userId: string,
    submissionId: number,
    body: { repoUrl?: string; deployUrl?: string; retro?: any }
  ): Promise<any> {
    this.ensureEnabled();
    const sub = await this.mySubmission(userId, submissionId);
    if (!['building', 'rework'].includes(sub.status)) {
      throw R.error('当前状态不能交作业');
    }
    const repoUrl = (body.repoUrl || '').trim();
    if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+/.test(repoUrl)) {
      throw R.error('请填写有效的 GitHub 公开仓库链接（github.com/用户名/仓库）');
    }
    await this.assertPublicRepo(repoUrl);
    const retro = body.retro || {};
    for (const [k, v] of [
      ['用了什么策略', retro.strategy],
      ['AI 在哪失败了', retro.aiFailed],
      ['你是怎么救的', retro.howFixed],
    ] as const) {
      if (!v || String(v).trim().length < 20) throw R.error(`复盘「${k}」至少写 20 字`);
    }
    if (sub.status === 'rework') sub.reworkCount = (sub.reworkCount || 0) + 1;
    sub.repoUrl = repoUrl;
    sub.deployUrl = (body.deployUrl || '').trim() || null;
    sub.retro = { strategy: retro.strategy, aiFailed: retro.aiFailed, howFixed: retro.howFixed };
    sub.status = 'submitted';
    await this.submissionModel.save(sub);
    return sub;
  }

  /** HEAD 校验仓库可公开访问；网络异常不阻断（生产 FC 可达 github，沙箱不可达时放行）。 */
  private async assertPublicRepo(repoUrl: string): Promise<void> {
    try {
      const res = await fetch(repoUrl, { method: 'HEAD', timeout: 6000 } as any);
      if (res.status === 404) throw R.error('仓库不存在或为私有，请改为公开仓库');
    } catch (e: any) {
      if (e?.code === 'BIZ_ERROR' || /私有/.test(e?.message || '')) throw e;
      /* 网络异常：不阻断交作业 */
    }
  }

  /** 我的做题列表（含题卡标题）。 */
  async my(userId: string): Promise<any> {
    this.ensureEnabled();
    if (!userId || userId.startsWith('guest:')) return [];
    const subs = await this.submissionModel.find({
      where: { userId },
      order: { updateTime: 'DESC' },
    });
    const missionIds = [...new Set(subs.map((s) => s.missionId))];
    const missions = missionIds.length
      ? await this.missionModel.find({ where: { id: In(missionIds as any) } })
      : [];
    const titleMap = new Map(missions.map((m) => [Number(m.id), m]));
    return subs.map((s) => {
      const m = titleMap.get(s.missionId);
      return {
        id: s.id,
        missionSlug: s.missionSlug,
        title: m?.title || s.missionSlug,
        tier: m?.tier,
        status: s.status,
        reworkCount: s.reworkCount,
        updateTime: s.updateTime,
      };
    });
  }

  /** 放弃做题。 */
  async abandon(userId: string, submissionId: number): Promise<any> {
    this.ensureEnabled();
    const sub = await this.mySubmission(userId, submissionId);
    if (['passed', 'abandoned'].includes(sub.status)) return sub;
    sub.status = 'abandoned';
    await this.submissionModel.save(sub);
    return sub;
  }

  /** 追加过程手记。 */
  async appendJournal(userId: string, submissionId: number, content: string): Promise<any> {
    this.ensureEnabled();
    const sub = await this.mySubmission(userId, submissionId);
    const add = String(content || '').trim();
    if (!add) return sub;
    sub.journal = `${sub.journal ? sub.journal + '\n\n' : ''}[${new Date().toISOString().slice(0, 16)}] ${add}`.slice(0, 20000);
    await this.submissionModel.save(sub);
    return sub;
  }

  /** 取本人的 submission，越权/不存在则抛错。 */
  private async mySubmission(userId: string, submissionId: number): Promise<MissionSubmissionEntity> {
    if (!userId || userId.startsWith('guest:')) throw R.unauthorizedError('请先登录');
    const sub = await this.submissionModel.findOne({ where: { id: submissionId as any } });
    if (!sub || sub.userId !== userId) throw R.error('做题记录不存在');
    return sub;
  }

  // ---- manager 题卡管理 ----

  async manageList(): Promise<any> {
    const missions = await this.missionModel.find({ order: { sortOrder: 'ASC' } });
    // 附每题数据列（领题/交作业/通过率）
    const result = [];
    for (const m of missions) {
      const claimed = await this.submissionModel.count({ where: { missionId: Number(m.id) } });
      const submitted = await this.submissionModel.count({
        where: { missionId: Number(m.id), status: In(['submitted', 'reviewing', 'passed', 'rework']) },
      });
      const passed = await this.submissionModel.count({
        where: { missionId: Number(m.id), status: 'passed' },
      });
      result.push({ ...m, stats: { claimed, submitted, passed } });
    }
    return result;
  }

  async manageSave(data: Partial<MissionEntity> & { slug: string }): Promise<any> {
    if (!data.slug) throw R.error('slug 必填');
    const existing = await this.missionModel.findOne({ where: { slug: data.slug } });
    if (existing) {
      Object.assign(existing, data);
      return this.missionModel.save(existing);
    }
    return this.missionModel.save(this.missionModel.create({ status: 'draft', ...data }));
  }

  async manageStatus(slug: string, status: 'draft' | 'published' | 'offline'): Promise<any> {
    const m = await this.missionModel.findOne({ where: { slug } });
    if (!m) throw R.error('题卡不存在');
    m.status = status;
    return this.missionModel.save(m);
  }
}
