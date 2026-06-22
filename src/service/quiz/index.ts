import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import { QuizQuestionEntity } from '../../entity/quizQuestion';
import { QuizAttemptEntity } from '../../entity/quizAttempt';
import { AiProxyService, Verdict } from '../ai/proxy';
import { RetrieveService } from '../ai/retrieve';
import { ArticleService } from '../article';
import { gradeObjective, scoreToMastery } from './grading';
import { GradeItem } from '../ai/prompts';
import { isEntitled } from '../../common/entitlement';
import { fetchArticleFromGitHub } from '../content/sync';

export interface SubmitAnswer {
  questionId: number;
  answer: string[];
}
export interface SubmitParams {
  userId: string;
  isMember: boolean;
  module: string;
  articleKey: string;
  answers: SubmitAnswer[];
  durationMs?: number;
}

const VERDICT_CREDIT: Record<Verdict, number> = { 对: 1, 部分对: 0.5, 错: 0 };

@Provide()
export class QuizService {
  @InjectEntityModel(QuizQuestionEntity)
  questionModel: Repository<QuizQuestionEntity>;

  @InjectEntityModel(QuizAttemptEntity)
  attemptModel: Repository<QuizAttemptEntity>;

  @Inject()
  aiProxyService: AiProxyService;

  @Inject()
  retrieveService: RetrieveService;

  @Inject()
  articleService: ArticleService;

  /** 取某文章已发布题目（答题用，剥离答案与解析）。 */
  async listForTake(module: string, articleKey: string) {
    const rows = await this.questionModel.find({
      where: { module, articleKey, status: 'published' },
      order: { orderNum: 'ASC', id: 'ASC' },
    });
    return rows.map((q) => ({
      id: q.id,
      type: q.type,
      stem: q.stem,
      options: q.options || undefined,
      difficulty: q.difficulty,
    }));
  }

  /** 管理端列表（含答案，分页/筛选）。 */
  async adminList(params: {
    module?: string;
    articleKey?: string;
    status?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const qb = this.questionModel.createQueryBuilder('q');
    if (params.module) qb.andWhere('q.module = :module', { module: params.module });
    if (params.articleKey)
      qb.andWhere('q.articleKey = :ak', { ak: params.articleKey });
    if (params.status) qb.andWhere('q.status = :status', { status: params.status });
    if (params.keyword)
      qb.andWhere('q.stem LIKE :kw', { kw: `%${params.keyword}%` });
    const total = await qb.getCount();
    const list = await qb
      .orderBy('q.updateTime', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();
    return { list, total };
  }

  async getById(id: number) {
    return this.questionModel.findOneBy({ id: String(id) });
  }

  /**
   * 基于文章自动出题入库为草稿（PRD-02 F2-1）。运营校审后再发布。
   */
  async generate(params: {
    userId: string;
    module: string;
    articleKey: string;
    count?: number;
    types?: string[];
  }) {
    const count = Math.min(Math.max(params.count || 3, 1), 5);
    const leaf = await this.articleService.findLeafByKey(params.module, params.articleKey);
    if (!leaf) throw new Error('未找到该文章（articleKey 与导航不匹配）');

    let content = '';
    try {
      content = await fetchArticleFromGitHub(params.module, leaf.filePath, params.articleKey);
    } catch {
      throw new Error('拉取文章内容失败');
    }
    if (!content.trim()) throw new Error('文章内容为空，无法出题');

    const drafts = await this.aiProxyService.generateQuestions(
      { title: leaf.label, content: content.slice(0, 6000), count, types: params.types },
      params.userId
    );
    if (!drafts.length) throw new Error('AI 未能生成题目，请重试');

    const saved = [];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      saved.push(
        await this.questionModel.save(
          this.questionModel.create({
            module: params.module,
            articleKey: params.articleKey,
            type: d.type,
            stem: d.stem,
            options: d.options || null,
            answer: d.answer || null,
            analysis: d.analysis || null,
            difficulty: d.difficulty || 1,
            source: 'ai',
            status: 'draft',
            tags: d.tags || null,
            orderNum: i,
          })
        )
      );
    }
    return { count: saved.length, list: saved };
  }

  async saveQuestion(data: Partial<QuizQuestionEntity> & { id?: number }) {
    if (data.id) {
      const existing = await this.questionModel.findOneBy({ id: String(data.id) });
      if (!existing) throw new Error('题目不存在');
      Object.assign(existing, data);
      return this.questionModel.save(existing);
    }
    return this.questionModel.save(this.questionModel.create(data));
  }

  async deleteQuestion(id: number) {
    await this.questionModel.delete({ id: String(id) });
    return { deleted: true };
  }

  /**
   * 提交作答：客观题规则判分 + 简答 AI 判分 + 汇总建议 + 掌握度回流（PRD-01 F1-1/F1-2/F1-4）。
   */
  async submit(params: SubmitParams) {
    const { userId, isMember, module, articleKey } = params;
    const answerMap = new Map(params.answers.map((a) => [Number(a.questionId), a.answer]));
    const ids = [...answerMap.keys()].map(String);
    const questions = ids.length
      ? await this.questionModel.find({ where: { id: In(ids) } })
      : [];

    // 1) 客观题规则判分；收集简答题待 AI 判分
    const qaItems: GradeItem[] = [];
    const qaIndexToQid: number[] = [];
    const perQuestion = questions.map((q) => {
      const ua = answerMap.get(Number(q.id)) || [];
      const objective = gradeObjective(
        { id: q.id!, type: q.type as any, answer: q.answer },
        ua
      );
      if (q.type === 'qa') {
        qaIndexToQid.push(Number(q.id));
        qaItems.push({
          stem: q.stem,
          keyPoints: q.answer || [],
          userAnswer: (ua || []).join(' '),
        });
      }
      return {
        question: q,
        userAnswer: ua,
        objective, // boolean | null
        credit: objective === true ? 1 : 0,
        correct: objective === true,
        verdict: undefined as Verdict | undefined,
        // 是否可计分：客观题有标准答案即可；简答需 AI 判分成功后才置 true
        scored: objective !== null,
      };
    });

    // 2) 简答 AI 判分 + 汇总建议（整次一调）
    // 配额保护：仅简答 AI 判分占用配额；超限时降级为「客观题计分 + 简答不评分」，不阻断闭环
    let feedback: { diagnosis: string; suggestions?: any } = { diagnosis: '' };
    if (qaItems.length) {
      let aiAllowed = true;
      try {
        await this.aiProxyService.checkRateLimit(userId, isMember);
      } catch {
        aiAllowed = false;
      }

      if (aiAllowed) {
        const member = isEntitled('personalized_feedback', { isMember });
        let candidates: { title: string; articleKey: string }[] = [];
        let profileSummary = '';
        if (member) {
          const query =
            qaItems.map((q) => q.stem).join(' ') || articleKey.replace(/[-_]/g, ' ');
          const hits = await this.retrieveService.retrieve(query, { module, topK: 5 });
          candidates = hits.map((h) => ({ title: h.title, articleKey: h.articleKey }));
          profileSummary = await this.articleService.getProfileSummary(userId, module);
        }
        const objectiveSummary = `客观题 ${
          perQuestion.filter((p) => p.objective !== null).length
        } 道`;
        const result = await this.aiProxyService.gradeSubmission(
          { items: qaItems, objectiveSummary, member, profileSummary, candidates },
          userId
        );
        // 回填简答 verdict（并标记为已计分）
        for (const v of result.itemVerdicts || []) {
          const qid = qaIndexToQid[v.index];
          const pq = perQuestion.find((p) => Number(p.question.id) === qid);
          if (pq) {
            pq.verdict = v.verdict;
            pq.credit = VERDICT_CREDIT[v.verdict] ?? 0;
            pq.correct = v.verdict === '对';
            pq.scored = true;
          }
        }
        feedback = { diagnosis: result.diagnosis || '', suggestions: result.suggestions };
      } else {
        feedback = {
          diagnosis: '今日 AI 判分次数已用完，简答题本次未评分；客观题成绩已记录。开通会员可无限使用。',
        };
      }
    }

    // 3) 计分：仅统计「可判定」的题（客观题 + 已 AI 判分的简答）
    const scoredItems = perQuestion.filter((p) => p.scored);
    const totalCount = scoredItems.length;
    const earned = scoredItems.reduce((s, p) => s + p.credit, 0);
    const correctCount = scoredItems.filter((p) => p.correct).length;
    const score = totalCount ? Math.round((earned / totalCount) * 100) : 0;

    // 4) 掌握度回流（本人测验，可升可降）+ 间隔重复排程（PRD-01 F2-1）
    let masteryChange: { from?: string; to: string } | null = null;
    if (totalCount > 0) {
      masteryChange = await this.articleService.reflowMastery(
        userId,
        module,
        articleKey,
        scoreToMastery(score),
        'authoritative'
      );
      try {
        await this.articleService.updateScheduleByScore(userId, module, articleKey, score);
      } catch {
        /* 排程更新失败不阻断 */
      }
    }

    // 5) 落库 attempt（尽力而为）
    try {
      await this.attemptModel.save(
        this.attemptModel.create({
          userId,
          module,
          articleKey,
          answers: perQuestion.map((p) => ({
            questionId: Number(p.question.id),
            answer: p.userAnswer,
            correct: p.correct,
            verdict: p.verdict,
          })),
          score,
          correctCount,
          totalCount,
          feedback,
          durationMs: params.durationMs || 0,
        })
      );
    } catch {
      /* 落库失败不阻断返回 */
    }

    // 6) 返回（提交后揭示答案与解析）
    return {
      score,
      correctCount,
      totalCount,
      mastery: masteryChange?.to,
      masteryFrom: masteryChange?.from,
      entitled: isEntitled('personalized_feedback', { isMember }),
      items: perQuestion.map((p) => ({
        questionId: Number(p.question.id),
        correct: p.correct,
        verdict: p.verdict,
        answer: p.question.answer,
        analysis: p.question.analysis,
      })),
      feedback,
    };
  }
}
