import { Provide, Inject, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository, In } from 'typeorm';
import fetch from 'node-fetch';
import { MissionReviewEntity } from '../../entity/missionReview';
import { SkillScoreEntity } from '../../entity/skillScore';
import { MissionSubmissionEntity } from '../../entity/missionSubmission';
import { MissionEntity } from '../../entity/mission';
import { UserEntity } from '../../entity/user';
import { AiProxyService } from '../ai/proxy';
import { MetricsService } from '../metrics';
import { sanitizeForPrompt } from '../ai/sanitize';
import { R } from '../../common/base.error.utils';

const SKILL_DIMS = ['requirement', 'ai_direction', 'engineering', 'debugging', 'knowledge'] as const;
const GH_API = 'https://api.github.com';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
/** 关键文件优先读取的扩展名与文件名。 */
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.py', '.md', '.json', '.vue'];
const KEY_FILES = ['readme.md', 'package.json', 'requirements.txt'];

/**
 * AI 评审与作品档案服务（PRD-03）。
 * read_github_repo（读仓库）→ 按题卡验收标准逐条打分 → 出报告/返工判定 → 写能力曲线。
 * 作品档案：以 user.inviteCode 作公开 slug，展示通过的题 + 报告 + 能力曲线。
 */
@Provide()
export class ReviewService {
  @InjectEntityModel(MissionReviewEntity)
  reviewModel: Repository<MissionReviewEntity>;

  @InjectEntityModel(SkillScoreEntity)
  skillModel: Repository<SkillScoreEntity>;

  @InjectEntityModel(MissionSubmissionEntity)
  submissionModel: Repository<MissionSubmissionEntity>;

  @InjectEntityModel(MissionEntity)
  missionModel: Repository<MissionEntity>;

  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @Inject()
  aiProxyService: AiProxyService;

  @Inject()
  metricsService: MetricsService;

  @Config('journey')
  journeyConfig: { reviewEnabled: boolean };

  /** 交作业后触发评审（异步，失败不影响交作业）。submitted→reviewing→passed/rework/need_human。 */
  async triggerAsync(submissionId: number): Promise<void> {
    if (!this.journeyConfig?.reviewEnabled) return;
    this.runReview(submissionId).catch(() => {});
  }

  /** 执行一次评审。 */
  async runReview(submissionId: number): Promise<MissionReviewEntity | null> {
    const sub = await this.submissionModel.findOne({ where: { id: submissionId as any } });
    if (!sub || sub.status !== 'submitted') return null;
    const mission = await this.missionModel.findOne({ where: { id: sub.missionId as any } });
    if (!mission) return null;

    sub.status = 'reviewing';
    await this.submissionModel.save(sub);

    let repoDigest = '';
    let repoSnapshot: any = { truncated: false };
    try {
      const r = await this.readRepo(sub.repoUrl);
      repoDigest = r.digest;
      repoSnapshot = r.snapshot;
    } catch {
      repoDigest = '(仓库读取失败，仅凭复盘与说明评审，判定谨慎)';
      repoSnapshot = { error: true };
    }

    const parsed = await this.gradeWithLLM(mission, sub, repoDigest);
    // mustPass 兜底：任一必过项 fail → 强制 rework
    let verdict = parsed.verdict;
    const criteria = Array.isArray(mission.acceptanceCriteria) ? mission.acceptanceCriteria : [];
    const mustPassFailed = (parsed.criteriaVerdicts || []).some((cv: any) => {
      const def = criteria.find((c: any) => String(c.id) === String(cv.id));
      return def?.mustPass && cv.verdict === 'fail';
    });
    if (mustPassFailed) verdict = 'rework';

    const review = await this.reviewModel.save(
      this.reviewModel.create({
        submissionId: Number(sub.id),
        missionId: sub.missionId,
        userId: sub.userId,
        verdict,
        totalScore: parsed.totalScore,
        scores: parsed.scores,
        criteriaVerdicts: parsed.criteriaVerdicts,
        report: parsed.report,
        repoSnapshot,
        makeupArticles: parsed.makeupArticles || null,
        reviewerModel: process.env.LLM_MODEL || 'deepseek-v4-flash',
        humanChecked: false,
      })
    );

    // 回写做题状态
    sub.latestReviewId = Number(review.id);
    if (verdict === 'pass') {
      sub.status = 'passed';
      await this.writeSkillScores(sub.userId, Number(sub.id), parsed.skills);
    } else if (verdict === 'rework') {
      sub.status = 'rework';
    } else {
      // need_human：留在 reviewing，等人工复核
      sub.status = 'reviewing';
    }
    await this.submissionModel.save(sub);
    this.metricsService
      .track({ userId: sub.userId, event: 'review_done', props: { verdict, submissionId: Number(sub.id) } })
      .catch(() => {});
    return review;
  }

  /** read_github_repo：读仓库 tree + 关键文件 + commits，产出有界摘要。 */
  async readRepo(repoUrl: string): Promise<{ digest: string; snapshot: any }> {
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    if (!m) throw R.error('无法解析仓库地址');
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');

    const meta = await this.gh(`/repos/${owner}/${repo}`);
    const branch = meta.default_branch || 'main';
    const treeRes = await this.gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
    const tree: any[] = Array.isArray(treeRes.tree) ? treeRes.tree : [];
    const files = tree.filter((t) => t.type === 'blob');

    // 选取关键文件（README/package + 若干源码），逐个读取正文（有界）
    const picks = files
      .filter((f) => {
        const lower = String(f.path).toLowerCase();
        return KEY_FILES.some((k) => lower.endsWith(k)) || CODE_EXT.some((e) => lower.endsWith(e));
      })
      .sort((a, b) => {
        const al = KEY_FILES.some((k) => a.path.toLowerCase().endsWith(k)) ? 0 : 1;
        const bl = KEY_FILES.some((k) => b.path.toLowerCase().endsWith(k)) ? 0 : 1;
        return al - bl;
      })
      .slice(0, 12);

    const parts: string[] = [];
    let used = 0;
    const BUDGET = 9000;
    for (const f of picks) {
      if (used > BUDGET) break;
      try {
        const content = await this.ghRaw(`/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${branch}`);
        const clip = sanitizeForPrompt(content, Math.min(1600, BUDGET - used));
        parts.push(`\n----- ${f.path} -----\n${clip}`);
        used += clip.length;
      } catch {
        /* 单文件读取失败跳过 */
      }
    }

    let commits: any[] = [];
    try {
      commits = await this.gh(`/repos/${owner}/${repo}/commits?per_page=20`);
    } catch {
      commits = [];
    }
    const commitMsgs = (commits || [])
      .map((c: any) => `- ${(c.commit?.message || '').split('\n')[0]}`)
      .slice(0, 20)
      .join('\n');

    const digest =
      `仓库：${owner}/${repo}（默认分支 ${branch}，共 ${files.length} 个文件）\n` +
      `提交历史（体现过程与演进）：\n${commitMsgs || '(无)'}\n` +
      `关键文件内容：${parts.join('\n') || '(未读到可展示文件)'}`;

    const snapshot = {
      owner,
      repo,
      branch,
      fileCount: files.length,
      commits: (commits || []).length,
      truncated: used > BUDGET,
    };
    return { digest: digest.slice(0, 12000), snapshot };
  }

  private async gh(path: string): Promise<any> {
    const res = await fetch(`${GH_API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(GH_TOKEN ? { Authorization: `token ${GH_TOKEN}` } : {}),
      },
      timeout: 10000,
    } as any);
    if (!res.ok) throw R.error(`GitHub API ${res.status}`);
    return res.json();
  }

  private async ghRaw(path: string): Promise<string> {
    const json = await this.gh(path);
    if (json?.content) {
      return Buffer.from(String(json.content).replace(/\n/g, ''), 'base64').toString('utf8');
    }
    return '';
  }

  /** 用 LLM 按验收标准打分，返回结构化结果；解析失败降级为 need_human。 */
  private async gradeWithLLM(
    mission: MissionEntity,
    sub: MissionSubmissionEntity,
    repoDigest: string
  ): Promise<any> {
    const criteria = Array.isArray(mission.acceptanceCriteria) ? mission.acceptanceCriteria : [];
    const critList = criteria
      .map((c: any, i: number) => `${c.id || i + 1}. ${c.text}${c.mustPass ? '（必过）' : ''}`)
      .join('\n');
    const retro = sub.retro || {};
    const system =
      '你是严格、诚实的项目评审官。按给定「验收标准」逐条判定用户提交的 GitHub 项目是否达标，' +
      '并给出返工/通过结论。评分三维：正确性(correctness,占50)、AI协作过程(process,占30，看提交历史与复盘是否体现真实的指挥AI过程)、工程质量(quality,占20)。' +
      '严禁编造仓库里不存在的内容；证据不足的条目判 uncertain。' +
      '只输出一个 JSON 对象，字段：verdict(pass|rework|need_human)、totalScore(0-100 整数)、' +
      'scores{correctness,process,quality}、criteriaVerdicts([{id,text,verdict(pass|fail|uncertain),note}])、' +
      'skills{requirement,ai_direction,engineering,debugging,knowledge}(各0-100整数)、report(markdown字符串,含亮点+问题+改进建议)。';
    const user =
      `题目：《${mission.title}》\n验收标准：\n${critList || '(未提供，按通用工程标准判断)'}\n\n` +
      `用户过程复盘：策略=${retro.strategy || ''}；AI失败点=${retro.aiFailed || ''}；如何解决=${retro.howFixed || ''}\n\n` +
      `${repoDigest}`;

    try {
      const raw = await this.aiProxyService.completeRaw(system, user, 'review');
      const parsed = this.parseJson(raw);
      if (!parsed || !['pass', 'rework', 'need_human'].includes(parsed.verdict)) {
        return this.fallbackReview('评审输出解析失败');
      }
      // 规整 skills
      const skills: any = {};
      for (const d of SKILL_DIMS) skills[d] = clampInt(parsed.skills?.[d], 0, 100, 60);
      return {
        verdict: parsed.verdict,
        totalScore: clampInt(parsed.totalScore, 0, 100, 60),
        scores: {
          correctness: clampInt(parsed.scores?.correctness, 0, 50, 30),
          process: clampInt(parsed.scores?.process, 0, 30, 18),
          quality: clampInt(parsed.scores?.quality, 0, 20, 12),
        },
        criteriaVerdicts: Array.isArray(parsed.criteriaVerdicts) ? parsed.criteriaVerdicts.slice(0, 30) : [],
        report: String(parsed.report || '').slice(0, 8000),
        skills,
        makeupArticles: null,
      };
    } catch {
      return this.fallbackReview('评审调用失败');
    }
  }

  private fallbackReview(reason: string): any {
    return {
      verdict: 'need_human',
      totalScore: 0,
      scores: { correctness: 0, process: 0, quality: 0 },
      criteriaVerdicts: [],
      report: `自动评审未完成（${reason}），已转人工复核。`,
      skills: null,
      makeupArticles: null,
    };
  }

  private async writeSkillScores(userId: string, submissionId: number, skills: any): Promise<void> {
    if (!skills) return;
    try {
      const rows = SKILL_DIMS.filter((d) => typeof skills[d] === 'number').map((d) =>
        this.skillModel.create({ userId, dimension: d, score: skills[d], submissionId, weight: 1 })
      );
      if (rows.length) await this.skillModel.save(rows);
    } catch {
      /* 能力曲线写入失败不影响评审结论 */
    }
  }

  private parseJson(text: string): any {
    if (!text) return null;
    const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  /** 取评审报告（本人）。 */
  async getReport(userId: string, submissionId: number): Promise<any> {
    const review = await this.reviewModel.findOne({
      where: { submissionId: submissionId as any, userId },
      order: { createTime: 'DESC' },
    });
    return review || null;
  }

  /** 人工复核：管理员置结论（need_human → pass/rework）。 */
  async humanReview(reviewId: number, verdict: 'pass' | 'rework', note?: string): Promise<any> {
    const review = await this.reviewModel.findOne({ where: { id: reviewId as any } });
    if (!review) throw R.error('评审不存在');
    review.verdict = verdict;
    review.humanChecked = true;
    if (note) review.report = `${review.report || ''}\n\n【人工复核】${note}`;
    await this.reviewModel.save(review);
    const sub = await this.submissionModel.findOne({ where: { id: review.submissionId as any } });
    if (sub) {
      sub.status = verdict === 'pass' ? 'passed' : 'rework';
      await this.submissionModel.save(sub);
      if (verdict === 'pass') {
        // 人工通过也补能力曲线（用报告 scores 无 skills 时给中位）
        await this.writeSkillScores(
          sub.userId,
          Number(sub.id),
          Object.fromEntries(SKILL_DIMS.map((d) => [d, 65]))
        );
      }
    }
    return review;
  }

  /** 作品档案（公开）：以 inviteCode 作 slug。展示通过的题 + 报告摘要 + 能力曲线。 */
  async getPortfolio(slug: string): Promise<any> {
    const user = await this.userModel.findOne({ where: { inviteCode: slug } });
    if (!user) throw R.error('作品档案不存在');
    const userId = user.phoneNumber;
    const passed = await this.submissionModel.find({
      where: { userId, status: 'passed' },
      order: { updateTime: 'DESC' },
    });
    const missionIds = [...new Set(passed.map((s) => s.missionId))];
    const missions = missionIds.length
      ? await this.missionModel.find({ where: { id: In(missionIds as any) } })
      : [];
    const mMap = new Map(missions.map((m) => [Number(m.id), m]));
    const reviews = passed.length
      ? await this.reviewModel.find({ where: { submissionId: In(passed.map((s) => Number(s.id)) as any) } })
      : [];
    const rMap = new Map(reviews.map((r) => [r.submissionId, r]));

    const projects = passed.map((s) => {
      const m = mMap.get(s.missionId);
      const r = rMap.get(Number(s.id));
      return {
        title: m?.title || s.missionSlug,
        tier: m?.tier,
        repoUrl: s.repoUrl,
        deployUrl: s.deployUrl,
        totalScore: r?.totalScore ?? null,
        summary: m?.summary,
        passedAt: s.updateTime,
      };
    });

    return {
      owner: { nickName: user.nickName, avatar: user.avatar, slug },
      projects,
      skillCurve: await this.skillCurve(userId),
    };
  }

  /** 能力曲线：各维度取最近若干次加权均值（近者权重高） + 时间序列。 */
  async skillCurve(userId: string): Promise<any> {
    const rows = await this.skillModel.find({
      where: { userId },
      order: { createTime: 'ASC' },
    });
    const byDim: Record<string, { score: number; at: any }[]> = {};
    for (const r of rows) {
      (byDim[r.dimension] = byDim[r.dimension] || []).push({ score: r.score, at: r.createTime });
    }
    const radar: Record<string, number | null> = {};
    for (const d of SKILL_DIMS) {
      const arr = byDim[d] || [];
      if (arr.length < 2) {
        radar[d] = arr.length === 1 ? arr[0].score : null; // <2 点显示"待积累"
        continue;
      }
      // 最近 3 次加权（3:2:1）
      const last = arr.slice(-3);
      const weights = last.map((_, i) => i + 1);
      const sum = last.reduce((acc, x, i) => acc + x.score * weights[i], 0);
      const wsum = weights.reduce((a, b) => a + b, 0);
      radar[d] = Math.round(sum / wsum);
    }
    return { radar, series: byDim };
  }
}

function clampInt(v: any, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
