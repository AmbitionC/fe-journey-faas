import { Provide, Inject, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { LearningPlanEntity } from '../../entity/learningPlan';
import { PlanWeekEntity } from '../../entity/planWeek';
import { UserGoalEntity } from '../../entity/userGoal';
import { MissionEntity } from '../../entity/mission';
import { EntitlementService } from '../entitlement';
import { AiProxyService } from '../ai/proxy';
import { R } from '../../common/base.error.utils';

/** 骨架六段（PRD-01 F2）：对标 Agent 工程师 JD 主干。 */
const SEGMENTS = [
  { seg: 1, theme: 'LLM 基础', topics: ['API 调用与鉴权', 'token 与上下文窗口'] },
  { seg: 2, theme: 'Prompt / 结构化输出 / Function Calling', topics: ['提示词工程', '结构化输出', 'function calling'] },
  { seg: 3, theme: 'RAG 检索增强', topics: ['检索召回', '向量与关键词', '引用与防幻觉'] },
  { seg: 4, theme: 'Agent 编排', topics: ['多步任务', '工具使用', '循环与纠偏'] },
  { seg: 5, theme: 'Eval 设计', topics: ['评测集设计', '自动判分', '回归防线'] },
  { seg: 6, theme: '生产化', topics: ['可观测性', '失败模式', '成本控制'] },
];

/** 每周时间档 → 节奏系数（周数倍率）。 */
const HOURS_FACTOR: Record<string, number> = { lt5: 2, h5_10: 1.4, h10_20: 1, h20plus: 0.7 };

@Provide()
export class PlanService {
  @InjectEntityModel(LearningPlanEntity)
  planModel: Repository<LearningPlanEntity>;

  @InjectEntityModel(PlanWeekEntity)
  weekModel: Repository<PlanWeekEntity>;

  @InjectEntityModel(UserGoalEntity)
  goalModel: Repository<UserGoalEntity>;

  @InjectEntityModel(MissionEntity)
  missionModel: Repository<MissionEntity>;

  @Inject()
  entitlementService: EntitlementService;

  @Inject()
  aiProxyService: AiProxyService;

  @Config('journey')
  journeyConfig: { planEnabled: boolean; planAiEnabled: boolean };

  private ensureEnabled(): void {
    if (!this.journeyConfig?.planEnabled) throw R.error('学习计划功能尚未开放');
  }

  /** 提交测评：回写 user_goal 画像，返回起点判定（不立即生成计划，由 generate 触发）。 */
  async submitAssessment(
    userId: string,
    data: {
      goal?: string;
      role?: string;
      yearsOfExp?: string;
      weeklyHours?: string;
      /** 摸底判定的起点段（教练 placement 给出）或自报水平映射 */
      startSegment?: number;
      snapshot?: any;
    }
  ): Promise<any> {
    this.ensureEnabled();
    if (!userId || userId.startsWith('guest:')) throw R.unauthorizedError('请先登录');
    const startSegment = Math.max(1, Math.min(3, Number(data.startSegment) || 1));

    // 回写 user_goal（教练 learner_state 用）
    let goal = await this.goalModel.findOne({ where: { userId } });
    if (!goal) {
      goal = this.goalModel.create({ userId, target: data.goal || 'ai' });
    }
    goal.role = data.role || goal.role;
    goal.yearsOfExp = data.yearsOfExp || goal.yearsOfExp;
    goal.weeklyHours = data.weeklyHours || goal.weeklyHours;
    await this.goalModel.save(goal);

    return {
      startSegment,
      startSegmentTheme: SEGMENTS.find((s) => s.seg === startSegment)?.theme,
      snapshot: {
        goal: data.goal,
        role: data.role,
        yearsOfExp: data.yearsOfExp,
        weeklyHours: data.weeklyHours,
        startSegment,
        ...(data.snapshot || {}),
      },
    };
  }

  /** 生成计划（幂等：已有 active 则返回）。会员+PLAN_AI 走个性化，否则静态骨架。 */
  async generate(
    userId: string,
    input: {
      goal?: string;
      role?: string;
      yearsOfExp?: string;
      weeklyHours?: string;
      startSegment?: number;
      snapshot?: any;
    },
    isMember: boolean
  ): Promise<any> {
    this.ensureEnabled();
    if (!userId || userId.startsWith('guest:')) throw R.unauthorizedError('请先登录');

    const existing = await this.planModel.findOne({ where: { userId, status: 'active' } });
    if (existing) return this.detailOf(existing);

    const weeklyHours = input.weeklyHours || 'h5_10';
    const startSegment = Math.max(1, Math.min(3, Number(input.startSegment) || 1));
    const weeksData = this.buildSkeleton(startSegment, weeklyHours);

    const plan = await this.planModel.save(
      this.planModel.create({
        userId,
        goal: input.goal || 'agent_dev',
        currentRole: input.role || '',
        yearsOfExp: input.yearsOfExp || '',
        weeklyHours,
        assessmentSnapshot: input.snapshot || null,
        startSegment,
        totalWeeks: weeksData.length,
        currentWeekNo: 1,
        source: 'static',
        status: 'active',
        skeletonVersion: 'v1',
      })
    );

    // AI 个性化（会员 + 开关）：仅改写 theme 措辞 + why，骨架结构不变
    let weeks = weeksData;
    if (isMember && this.journeyConfig?.planAiEnabled) {
      const personalized = await this.personalize(weeksData, input).catch(() => null);
      if (personalized) {
        weeks = personalized;
        plan.source = 'ai';
        await this.planModel.save(plan);
      }
    }

    // 落 plan_week
    const rows = weeks.map((w, i) =>
      this.weekModel.create({
        planId: Number(plan.id),
        weekNo: i + 1,
        segment: w.segment,
        theme: w.theme,
        nodes: w.nodes,
        status: i === 0 ? 'active' : 'pending',
      })
    );
    await this.weekModel.save(rows);
    return this.detailOf(plan);
  }

  /** 规则引擎：从骨架模板 + 起点段 + 时间档生成周列表，尽量挂上已发布题卡。 */
  private buildSkeleton(
    startSegment: number,
    weeklyHours: string
  ): { segment: number; theme: string; nodes: any[] }[] {
    const factor = HOURS_FACTOR[weeklyHours] ?? 1;
    const segs = SEGMENTS.filter((s) => s.seg >= startSegment);
    const weeks: { segment: number; theme: string; nodes: any[] }[] = [];
    for (const s of segs) {
      const wCount = Math.max(1, Math.round(2 * factor));
      const topicsPerWeek = Math.ceil(s.topics.length / wCount);
      for (let w = 0; w < wCount; w++) {
        const topics = s.topics.slice(w * topicsPerWeek, (w + 1) * topicsPerWeek);
        if (!topics.length && w > 0) continue; // 主题分完就不再多铺空周
        const nodes: any[] = topics.map((t) => ({
          type: 'read_teach',
          ref: t,
          title: `读 + 讲：${t}`,
          status: 'todo',
        }));
        weeks.push({
          segment: s.seg,
          theme: `第${s.seg}段 · ${s.theme}${wCount > 1 ? `（${w + 1}/${wCount}）` : ''}`,
          nodes,
        });
      }
    }
    return weeks;
  }

  /** 挂题卡：把已发布题卡按 sortOrder 铺到各段末周（缺题则占位预告，防空节点）。 */
  private async attachMissions(planId: number): Promise<void> {
    const weeks = await this.weekModel.find({ where: { planId }, order: { weekNo: 'ASC' } });
    const missions = await this.missionModel.find({
      where: { status: 'published' as any },
      order: { sortOrder: 'ASC' },
    });
    let mi = 0;
    // 每段最后一周挂一道题
    for (let i = 0; i < weeks.length; i++) {
      const isSegEnd = i === weeks.length - 1 || weeks[i + 1].segment !== weeks[i].segment;
      if (!isSegEnd) continue;
      const nodes = Array.isArray(weeks[i].nodes) ? weeks[i].nodes : [];
      if (mi < missions.length) {
        const m = missions[mi++];
        nodes.push({ type: 'mission', ref: m.slug, title: `实战题：${m.title}`, status: 'todo' });
      } else {
        nodes.push({ type: 'mission', ref: '', title: '本段实战题第 X 期开放（占位预告）', status: 'todo', placeholder: true });
      }
      weeks[i].nodes = nodes;
      await this.weekModel.save(weeks[i]);
    }
  }

  /** AI 个性化：改写每周主题措辞 + 一句「为什么这周学这个」。失败返回 null（降级静态）。 */
  private async personalize(
    weeks: { segment: number; theme: string; nodes: any[] }[],
    input: any
  ): Promise<{ segment: number; theme: string; nodes: any[] }[] | null> {
    const system =
      '你是学习规划教练。给定一份按周排的学习骨架和用户画像，为每一周产出更贴合用户的「主题措辞」和一句「为什么这周学这个」。' +
      '不要改变周数与顺序，不要改 segment。只输出 JSON 数组，每项 {theme, why}，长度与输入周数一致。中文。';
    const skeleton = weeks.map((w, i) => `第${i + 1}周(seg${w.segment}): ${w.theme}`).join('\n');
    const user = `用户画像：目标=${input.goal || ''} 岗位=${input.role || ''} 年限=${input.yearsOfExp || ''} 每周=${input.weeklyHours || ''}\n骨架：\n${skeleton}`;
    const raw = await this.aiProxyService.completeRaw(system, user, 'plan-ai');
    const arr = this.parseJsonArray(raw);
    if (!Array.isArray(arr) || arr.length !== weeks.length) return null;
    return weeks.map((w, i) => ({
      segment: w.segment,
      theme: String(arr[i]?.theme || w.theme).slice(0, 120),
      nodes: [
        ...(arr[i]?.why ? [{ type: 'note', ref: '', title: `为什么这周：${String(arr[i].why).slice(0, 100)}`, status: 'todo' }] : []),
        ...w.nodes,
      ],
    }));
  }

  private parseJsonArray(text: string): any[] | null {
    if (!text) return null;
    const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  /** 计划详情（当前计划 + 全部周）。无计划返回 null。 */
  async detail(userId: string): Promise<any> {
    this.ensureEnabled();
    const plan = await this.planModel.findOne({ where: { userId, status: 'active' } });
    if (!plan) return null;
    return this.detailOf(plan);
  }

  private async detailOf(plan: LearningPlanEntity): Promise<any> {
    // 首次读取时补挂题卡（幂等：已挂过 mission 节点则跳过）
    const existingWeeks = await this.weekModel.find({ where: { planId: Number(plan.id) }, order: { weekNo: 'ASC' } });
    const hasMission = existingWeeks.some((w) => Array.isArray(w.nodes) && w.nodes.some((n: any) => n.type === 'mission'));
    if (!hasMission) {
      await this.attachMissions(Number(plan.id));
    }
    const weeks = await this.weekModel.find({ where: { planId: Number(plan.id) }, order: { weekNo: 'ASC' } });
    return { plan, weeks };
  }

  /** 节点完成回填（两模块回写 + 用户手动勾读类节点）。 */
  async completeNode(userId: string, weekNo: number, nodeRef: string): Promise<any> {
    this.ensureEnabled();
    const plan = await this.planModel.findOne({ where: { userId, status: 'active' } });
    if (!plan) throw R.error('无进行中的计划');
    const week = await this.weekModel.findOne({ where: { planId: Number(plan.id), weekNo } });
    if (!week) throw R.error('周不存在');
    const nodes = Array.isArray(week.nodes) ? week.nodes : [];
    let changed = false;
    for (const n of nodes) {
      if (n.ref === nodeRef && n.status !== 'done') {
        n.status = 'done';
        n.doneAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      week.nodes = nodes;
      if (nodes.every((n: any) => n.status === 'done')) week.status = 'done';
      await this.weekModel.save(week);
    }
    return week;
  }

  /** 周对账提交：记录 + 轻量调整下周（没懂→插复习提示）。 */
  async checkin(
    userId: string,
    weekNo: number,
    data: { completed?: number; total?: number; blocker?: string; blockerText?: string; adjustChoice?: string }
  ): Promise<any> {
    this.ensureEnabled();
    const plan = await this.planModel.findOne({ where: { userId, status: 'active' } });
    if (!plan) throw R.error('无进行中的计划');
    const week = await this.weekModel.findOne({ where: { planId: Number(plan.id), weekNo } });
    if (!week) throw R.error('周不存在');
    week.checkinAt = new Date();
    week.checkinData = data;
    week.status = 'done';
    await this.weekModel.save(week);

    // 轻量下周调整
    const next = await this.weekModel.findOne({ where: { planId: Number(plan.id), weekNo: weekNo + 1 } });
    if (next) {
      if (data.blocker === 'not_understood') {
        next.aiAdjustNote = '上周有知识点没懂，本周先插一节复习再继续';
      } else if (data.blocker === 'too_hard') {
        next.aiAdjustNote = '上周偏难，本周节奏放缓';
      } else if (data.blocker === 'no_time') {
        next.aiAdjustNote = '上周时间紧，本周只保留核心节点';
      }
      next.status = 'active';
      await this.weekModel.save(next);
      plan.currentWeekNo = weekNo + 1;
      await this.planModel.save(plan);
    } else {
      plan.status = 'finished';
      await this.planModel.save(plan);
    }
    return { week, next };
  }

  /** 主动调整：改时间档/暂停/恢复/放弃重来。 */
  async adjust(userId: string, type: 'hours' | 'pause' | 'resume' | 'abandon', payload?: any): Promise<any> {
    this.ensureEnabled();
    const plan = await this.planModel.findOne({
      where: { userId, status: type === 'resume' ? ('paused' as any) : ('active' as any) },
    });
    if (!plan) throw R.error('无可调整的计划');
    if (type === 'pause') plan.status = 'paused';
    else if (type === 'resume') plan.status = 'active';
    else if (type === 'abandon') plan.status = 'abandoned';
    else if (type === 'hours' && payload?.weeklyHours) plan.weeklyHours = payload.weeklyHours;
    await this.planModel.save(plan);
    return plan;
  }

  /** 周对账汇总（供站长外部 skill 起草群提醒，仅管理员）。 */
  async checkinSummary(): Promise<any> {
    const active = await this.planModel.count({ where: { status: 'active' } });
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const recentCheckins = await this.weekModel
      .createQueryBuilder('w')
      .where('w.checkinAt >= :d', { d: weekAgo })
      .getCount();
    return { activePlans: active, checkinsLast7d: recentCheckins };
  }
}
