import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import { AlgorithmProblemEntity } from '../../entity/algorithm/problem';
import { AlgorithmTestCaseEntity } from '../../entity/algorithm/testCase';
import { AlgorithmTagEntity } from '../../entity/algorithm/tag';
import { AlgorithmProblemTagEntity } from '../../entity/algorithm/problemTag';
import { AlgorithmSubmissionEntity } from '../../entity/algorithm/submission';
import { AlgorithmCodeDraftEntity } from '../../entity/algorithm/codeDraft';
import { AlgorithmProblemFlagEntity } from '../../entity/algorithm/problemFlag';
import { Judge0ClientService } from './judge0Client';
import { InterviewQuestionIndexService } from '../interview/questionIndex';
import { R } from '../../common/base.error.utils';
import {
  buildActivity,
  buildProblemLists,
  buildRecommendations,
  computeStreak,
  findSimilar,
  matchInterviewRefs,
  toDayKey,
  InterviewRefs,
  ProblemLite,
  ProblemListMeta,
} from '../../common/algorithmPractice';

/** 面经引用匹配结果按面经索引版本缓存在进程内（索引本身 10 分钟失效）。 */
let refsCache: { version: string; map: Map<string, InterviewRefs> } | null =
  null;

@Provide()
export class AlgorithmService {
  @InjectEntityModel(AlgorithmProblemEntity)
  problemModel: Repository<AlgorithmProblemEntity>;

  @InjectEntityModel(AlgorithmTestCaseEntity)
  testCaseModel: Repository<AlgorithmTestCaseEntity>;

  @InjectEntityModel(AlgorithmTagEntity)
  tagModel: Repository<AlgorithmTagEntity>;

  @InjectEntityModel(AlgorithmProblemTagEntity)
  problemTagModel: Repository<AlgorithmProblemTagEntity>;

  @InjectEntityModel(AlgorithmSubmissionEntity)
  submissionModel: Repository<AlgorithmSubmissionEntity>;

  @InjectEntityModel(AlgorithmCodeDraftEntity)
  draftModel: Repository<AlgorithmCodeDraftEntity>;

  @InjectEntityModel(AlgorithmProblemFlagEntity)
  problemFlagModel: Repository<AlgorithmProblemFlagEntity>;

  @Inject()
  judge0ClientService: Judge0ClientService;

  @Inject()
  questionIndex: InterviewQuestionIndexService;

  // ========== 题库快照 / 面经引用 ==========

  /** 全部已发布题目 + 标签（三条小查询，题库不到百道，不做分页）。 */
  async loadProblemsLite(): Promise<ProblemLite[]> {
    const rows = await this.problemModel.find({
      where: { status: 'published' },
      select: ['id', 'slug', 'title', 'difficulty', 'orderNum', 'listSlugs'],
      order: { orderNum: 'ASC', id: 'ASC' },
    });
    const tagsMap = await this.loadTagsMap(rows.map(p => p.id));
    return rows.map(p => ({
      id: String(p.id),
      slug: p.slug,
      title: p.title,
      difficulty: p.difficulty,
      orderNum: p.orderNum,
      tags: tagsMap[p.id] || [],
      listSlugs: p.listSlugs,
    }));
  }

  private async loadTagsMap(problemIds: Array<string | number>) {
    const tagsMap: Record<string, { id: string; name: string }[]> = {};
    if (!problemIds.length) return tagsMap;
    const relations = await this.problemTagModel.find({
      where: { problemId: In(problemIds.map(Number)) },
    });
    const tagIds = [...new Set(relations.map(r => r.tagId))];
    const tags = tagIds.length
      ? await this.tagModel.find({ where: { id: In(tagIds.map(String)) } })
      : [];
    const tagMap = Object.fromEntries(tags.map(t => [t.id, t]));
    for (const r of relations) {
      if (!tagsMap[r.problemId]) tagsMap[r.problemId] = [];
      if (tagMap[r.tagId])
        tagsMap[r.problemId].push({
          id: String(tagMap[r.tagId].id),
          name: tagMap[r.tagId].name,
        });
    }
    return tagsMap;
  }

  /**
   * 题目 slug → 面经引用。面经索引取不到（本地无内容表等）时返回空表，不影响题库功能。
   */
  async getInterviewRefsMap(
    problems?: ProblemLite[]
  ): Promise<Map<string, InterviewRefs>> {
    try {
      const index = await this.questionIndex.load();
      if (refsCache && refsCache.version === index.version)
        return refsCache.map;
      const list = problems || (await this.loadProblemsLite());
      const map = matchInterviewRefs(list, index.index);
      refsCache = { version: index.version, map };
      return map;
    } catch {
      return refsCache?.map || new Map();
    }
  }

  // ========== 用户端 ==========

  async getProblems(params: {
    page?: number;
    pageSize?: number;
    difficulty?: string;
    tagId?: number;
    keyword?: string;
  }) {
    const { page = 1, pageSize = 20, difficulty, tagId, keyword } = params;

    const qb = this.problemModel
      .createQueryBuilder('p')
      .where('p.status = :status', { status: 'published' });

    if (difficulty) {
      qb.andWhere('p.difficulty = :difficulty', { difficulty });
    }
    if (keyword) {
      qb.andWhere('p.title LIKE :keyword', { keyword: `%${keyword}%` });
    }
    if (tagId) {
      qb.innerJoin(
        AlgorithmProblemTagEntity,
        'pt',
        'pt.problemId = p.id AND pt.tagId = :tagId',
        { tagId }
      );
    }

    qb.orderBy('p.orderNum', 'ASC').addOrderBy('p.id', 'ASC');

    const total = await qb.getCount();
    const list = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    const tagsMap = await this.loadTagsMap(list.map(p => p.id));
    const refs = await this.getInterviewRefsMap();

    return {
      list: list.map(p => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        difficulty: p.difficulty,
        orderNum: p.orderNum,
        acceptCount: p.acceptCount,
        submitCount: p.submitCount,
        tags: tagsMap[p.id] || [],
        interviewCount: refs.get(p.slug)?.count || 0,
        listSlugs: Array.isArray(p.listSlugs) ? p.listSlugs : [],
      })),
      total,
      page,
      pageSize,
    };
  }

  async getProblemDetail(slug: string) {
    const problem = await this.problemModel.findOneBy({ slug });
    if (!problem) throw R.error('题目不存在');

    const sampleCases = await this.testCaseModel.find({
      where: { problemId: Number(problem.id), isSample: true },
      order: { orderNum: 'ASC' },
    });

    const tagRelations = await this.problemTagModel.find({
      where: { problemId: Number(problem.id) },
    });
    const tagIds = tagRelations.map(r => r.tagId);
    const tags = tagIds.length
      ? await this.tagModel.find({ where: { id: In(tagIds.map(String)) } })
      : [];

    // 面经引用与相似题：任一步失败都不影响题目本身的加载
    let interviewRefs: InterviewRefs | null = null;
    let similar: Array<{ slug: string; title: string; difficulty: string }> =
      [];
    try {
      const all = await this.loadProblemsLite();
      const refs = await this.getInterviewRefsMap(all);
      interviewRefs = refs.get(problem.slug) || null;
      const me = all.find(p => p.slug === problem.slug);
      if (me)
        similar = findSimilar(me, all).map(p => ({
          slug: p.slug,
          title: p.title,
          difficulty: p.difficulty,
        }));
    } catch {
      /* 练习中心的附加信息，失败静默 */
    }

    return {
      ...problem,
      sampleCases: sampleCases.map(tc => ({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
      })),
      tags,
      relatedArticles: problem.relatedArticles || [],
      interviewRefs,
      similar,
    };
  }

  /** 轻量存在性检查（单条唯一索引查询），供启动 seeder 幂等判断用。 */
  async hasProblem(slug: string): Promise<boolean> {
    return !!(await this.problemModel.findOneBy({ slug }));
  }

  async getTags() {
    return this.tagModel.find({ order: { name: 'ASC' } });
  }

  async runCode(params: {
    problemId: number;
    language: string;
    code: string;
    userId: string;
  }) {
    const { problemId, language, code, userId } = params;

    const sampleCases = await this.testCaseModel.find({
      where: { problemId, isSample: true },
      order: { orderNum: 'ASC' },
    });

    if (!sampleCases.length) throw R.error('该题目没有示例用例');

    const judgeResult = await this.judge0ClientService.runTestCases(
      code,
      language,
      sampleCases.map(tc => ({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
      }))
    );

    let status = 'accepted';
    if (!judgeResult.allPassed) {
      const failedResult = judgeResult.results.find(r => !r.passed);
      if (failedResult?.error) {
        status = failedResult.error.includes('compilation')
          ? 'compile_error'
          : 'runtime_error';
      } else {
        status = 'wrong_answer';
      }
    }

    const submission = new AlgorithmSubmissionEntity();
    submission.type = 'run';
    submission.problemId = problemId;
    submission.userId = userId;
    submission.language = language;
    submission.code = code;
    submission.status = status;
    submission.runtime = judgeResult.totalRuntime;
    submission.memory = judgeResult.maxMemory;
    submission.errorMessage =
      judgeResult.results.find(r => r.error)?.error || null;
    submission.testResults = JSON.stringify(judgeResult.results);

    await this.submissionModel.save(submission);

    return {
      ...judgeResult,
      submissionId: submission.id,
      status,
    };
  }

  async submitCode(params: {
    problemId: number;
    language: string;
    code: string;
    userId: string;
  }) {
    const { problemId, language, code, userId } = params;

    const problem = await this.problemModel.findOneBy({
      id: String(problemId),
    });
    if (!problem) throw R.error('题目不存在');

    const allCases = await this.testCaseModel.find({
      where: { problemId },
      order: { orderNum: 'ASC' },
    });

    if (!allCases.length) throw R.error('该题目没有测试用例');

    const judgeResult = await this.judge0ClientService.runTestCases(
      code,
      language,
      allCases.map(tc => ({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
      }))
    );

    let status = 'accepted';
    if (!judgeResult.allPassed) {
      const failedResult = judgeResult.results.find(r => !r.passed);
      if (failedResult?.error) {
        status = failedResult.error.includes('compilation')
          ? 'compile_error'
          : 'runtime_error';
      } else {
        status = 'wrong_answer';
      }
    }

    const submission = new AlgorithmSubmissionEntity();
    submission.type = 'submit';
    submission.problemId = problemId;
    submission.userId = userId;
    submission.language = language;
    submission.code = code;
    submission.status = status;
    submission.runtime = judgeResult.totalRuntime;
    submission.memory = judgeResult.maxMemory;
    submission.errorMessage =
      judgeResult.results.find(r => r.error)?.error || null;
    submission.testResults = JSON.stringify(judgeResult.results);

    await this.submissionModel.save(submission);

    problem.submitCount += 1;
    if (status === 'accepted') problem.acceptCount += 1;
    await this.problemModel.save(problem);

    return {
      ...judgeResult,
      submissionId: submission.id,
      status,
      runtime: judgeResult.totalRuntime,
      memory: judgeResult.maxMemory,
      results: judgeResult.results,
      passedCount: judgeResult.results.filter(r => r.passed).length,
      totalCount: allCases.length,
    };
  }

  async getSubmissions(params: {
    problemId: number;
    userId: string;
    page?: number;
    pageSize?: number;
  }) {
    const { problemId, userId, page = 1, pageSize = 20 } = params;

    const [list, total] = await this.submissionModel.findAndCount({
      where: { problemId, userId, type: 'submit' },
      order: { createTime: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      list: list.map(s => ({
        id: s.id,
        type: s.type,
        language: s.language,
        status: s.status,
        runtime: s.runtime,
        memory: s.memory,
        createTime: s.createTime,
      })),
      total,
      page,
      pageSize,
    };
  }

  // ========== 草稿与最近结果 ==========

  async saveDraft(params: {
    userId: string;
    problemId: number;
    language: string;
    code: string;
  }) {
    const { userId, problemId, language, code } = params;
    const existing = await this.draftModel.findOneBy({
      userId,
      problemId,
      language,
    });

    if (existing) {
      existing.code = code;
      return this.draftModel.save(existing);
    }

    const draft = new AlgorithmCodeDraftEntity();
    draft.userId = userId;
    draft.problemId = problemId;
    draft.language = language;
    draft.code = code;
    return this.draftModel.save(draft);
  }

  async getDrafts(userId: string, problemId: number) {
    const drafts = await this.draftModel.find({
      where: { userId, problemId },
    });
    const map: Record<string, string> = {};
    for (const d of drafts) {
      map[d.language] = d.code;
    }
    return map;
  }

  async getLastResult(userId: string, problemId: number) {
    const last = await this.submissionModel.findOne({
      where: { userId, problemId },
      order: { createTime: 'DESC' },
    });

    if (!last) return null;

    let parsedResults: Array<{ passed?: boolean }> = [];
    try {
      parsedResults = last.testResults ? JSON.parse(last.testResults) : [];
    } catch {
      parsedResults = [];
    }

    return {
      id: last.id,
      type: last.type,
      language: last.language,
      status: last.status,
      runtime: last.runtime,
      memory: last.memory,
      errorMessage: last.errorMessage,
      testResults: last.testResults,
      allPassed: last.status === 'accepted',
      passedCount: parsedResults.filter(result => result?.passed).length,
      totalCount: parsedResults.length,
      createTime: last.createTime,
    };
  }

  async getUserProblemStatuses(userId: string) {
    const rows: Array<{ problemId: number; status: string }> =
      await this.submissionModel
        .createQueryBuilder('s')
        .select('s.problemId', 'problemId')
        .addSelect('s.status', 'status')
        .where('s.userId = :userId', { userId })
        .andWhere('s.type = :type', { type: 'submit' })
        .orderBy('s.createTime', 'ASC')
        .getRawMany();

    const map: Record<string, 'accepted' | 'attempted'> = {};
    for (const row of rows) {
      const pid = String(row.problemId);
      if (row.status === 'accepted') {
        map[pid] = 'accepted';
      } else if (!map[pid]) {
        map[pid] = 'attempted';
      }
    }
    return map;
  }

  // ========== 题单 ==========

  /**
   * 题单：面经高频 / 校招高频 / 剑指 Offer / 知识点专题（自动）+ 后台人工题单。
   * 此前三个固定题单从没填过 listSlugs、线上全是 0 题，改为自动生成兜底。
   */
  async getProblemLists(): Promise<ProblemListMeta[]> {
    const problems = await this.loadProblemsLite();
    const refs = await this.getInterviewRefsMap(problems);
    return buildProblemLists(problems, refs);
  }

  // ========== 练习中心概览 ==========

  /**
   * 练习中心首页一次拿齐：进度、连续天数、近 12 周活跃、最近练习、今日推荐、题单进度。
   * 未登录也能看（全部个人数据为空，推荐退化为「顺序往下练 + 面经高频」）。
   */
  async getOverview(userId: string | null) {
    const problems = await this.loadProblemsLite();
    const refs = await this.getInterviewRefsMap(problems);
    const lists = buildProblemLists(problems, refs);
    const byId = new Map(problems.map(p => [p.id, p]));
    const today = toDayKey(new Date());

    const totals = { total: problems.length, easy: 0, medium: 0, hard: 0 };
    for (const p of problems)
      if (p.difficulty in totals) (totals as any)[p.difficulty] += 1;

    let statusMap: Record<string, 'accepted' | 'attempted'> = {};
    let flags: Record<string, 'favorite' | 'redo'> = {};
    let submissions: AlgorithmSubmissionEntity[] = [];
    if (userId) {
      [statusMap, flags] = await Promise.all([
        this.getUserProblemStatuses(userId),
        this.getUserFlags(userId),
      ]);
      submissions = await this.submissionModel.find({
        where: { userId },
        select: ['problemId', 'status', 'type', 'createTime'],
        order: { createTime: 'DESC' },
        take: 2000,
      });
    }

    const solved = { total: 0, easy: 0, medium: 0, hard: 0 };
    let attempted = 0;
    for (const [pid, st] of Object.entries(statusMap)) {
      const p = byId.get(String(pid));
      if (!p) continue;
      if (st === 'accepted') {
        solved.total += 1;
        if (p.difficulty in solved) (solved as any)[p.difficulty] += 1;
      } else attempted += 1;
    }

    const submits = submissions.filter(s => s.type === 'submit');
    const dayKeys = new Set(submits.map(s => toDayKey(s.createTime)));
    const streak = computeStreak(dayKeys, today);
    const activity = buildActivity(
      submits.map(s => ({
        createTime: s.createTime || new Date(),
        status: s.status,
      })),
      today
    );

    // 最近练过的题（去重，按最近一次提交时间）
    const recent: Array<{
      slug: string;
      title: string;
      difficulty: string;
      status: string;
      at: Date;
    }> = [];
    const seen = new Set<number>();
    for (const sub of submissions) {
      if (seen.has(sub.problemId)) continue;
      const p = byId.get(String(sub.problemId));
      if (!p) continue;
      seen.add(sub.problemId);
      recent.push({
        slug: p.slug,
        title: p.title,
        difficulty: p.difficulty,
        status: statusMap[p.id] || 'attempted',
        at: sub.createTime,
      });
      if (recent.length >= 5) break;
    }

    const lastAccepted = submits.find(s => s.status === 'accepted');
    const recommendations = buildRecommendations({
      problems,
      statusMap,
      flags,
      refs,
      lastAcceptedSlug: lastAccepted
        ? byId.get(String(lastAccepted.problemId))?.slug
        : null,
    }).map(r => {
      const p = problems.find(x => x.slug === r.slug)!;
      return {
        ...r,
        title: p.title,
        difficulty: p.difficulty,
        tags: p.tags.map(t => t.name).slice(0, 3),
        interviewCount: refs.get(p.slug)?.count || 0,
      };
    });

    const bySlug = new Map(problems.map(p => [p.slug, p]));
    const listsWithProgress = lists.map(l => ({
      slug: l.slug,
      title: l.title,
      description: l.description,
      kind: l.kind,
      count: l.problemSlugs.length,
      solved: l.problemSlugs.filter(sl => {
        const p = bySlug.get(sl);
        return p && statusMap[p.id] === 'accepted';
      }).length,
    }));

    // 弱项：有提交但没过的题所属标签（去重，按题数降序，最多 4 个）
    const weak = new Map<string, number>();
    for (const [pid, st] of Object.entries(statusMap)) {
      if (st !== 'attempted') continue;
      for (const t of byId.get(String(pid))?.tags || []) {
        if (t.name === '剑指 Offer') continue;
        weak.set(t.name, (weak.get(t.name) || 0) + 1);
      }
    }
    const weakTags = [...weak.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({ name, count }));

    return {
      loggedIn: !!userId,
      totals,
      solved,
      attempted,
      streak,
      activity,
      recent,
      recommendations,
      lists: listsWithProgress,
      weakTags,
      interviewHotCount:
        lists.find(l => l.slug === 'interview-hot')?.problemSlugs.length || 0,
    };
  }

  // ========== 管理端 ==========

  async saveProblem(params: {
    id?: number;
    title: string;
    slug: string;
    difficulty: string;
    description: string;
    defaultCode?: string;
    solution?: string;
    orderNum?: number;
    status?: string;
    tagIds?: number[];
    listSlugs?: string[] | null;
  }) {
    const { tagIds, ...data } = params;

    let problem: AlgorithmProblemEntity;
    if (data.id) {
      problem = await this.problemModel.findOneBy({ id: String(data.id) });
      if (!problem) throw R.error('题目不存在');
      Object.assign(problem, data);
    } else {
      const existing = await this.problemModel.findOneBy({ slug: data.slug });
      if (existing) throw R.error(`slug "${data.slug}" 已存在`);
      problem = Object.assign(new AlgorithmProblemEntity(), data);
    }

    await this.problemModel.save(problem);

    if (tagIds !== undefined) {
      await this.problemTagModel.delete({ problemId: Number(problem.id) });
      if (tagIds.length) {
        const relations = tagIds.map(tagId => {
          const pt = new AlgorithmProblemTagEntity();
          pt.problemId = Number(problem.id);
          pt.tagId = tagId;
          return pt;
        });
        await this.problemTagModel.save(relations);
      }
    }

    return problem;
  }

  async deleteProblem(id: number) {
    await this.testCaseModel.delete({ problemId: id });
    await this.problemTagModel.delete({ problemId: id });
    await this.submissionModel.delete({ problemId: id });
    await this.problemModel.delete({ id: String(id) });
    return { success: true };
  }

  async saveTestCases(
    problemId: number,
    testCases: Array<{
      id?: number;
      input: string;
      expectedOutput: string;
      isSample?: boolean;
      orderNum?: number;
    }>
  ) {
    const problem = await this.problemModel.findOneBy({
      id: String(problemId),
    });
    if (!problem) throw R.error('题目不存在');

    await this.testCaseModel.delete({ problemId });

    const entities = testCases.map((tc, idx) => {
      const entity = new AlgorithmTestCaseEntity();
      entity.problemId = problemId;
      entity.input = tc.input;
      entity.expectedOutput = tc.expectedOutput;
      entity.isSample = tc.isSample ?? false;
      entity.orderNum = tc.orderNum ?? idx;
      return entity;
    });

    await this.testCaseModel.save(entities);
    return entities;
  }

  async saveTag(name: string) {
    const existing = await this.tagModel.findOneBy({ name });
    if (existing) return existing;

    const tag = new AlgorithmTagEntity();
    tag.name = name;
    return this.tagModel.save(tag);
  }

  // ========== 收藏 / 标记重做 ==========

  async toggleFlag(
    userId: string,
    slug: string,
    flag: 'favorite' | 'redo' | null
  ) {
    const existing = await this.problemFlagModel.findOneBy({ userId, slug });
    if (flag === null) {
      if (existing) await this.problemFlagModel.remove(existing);
      return { slug, flag: null };
    }
    if (existing) {
      existing.flag = flag;
      await this.problemFlagModel.save(existing);
      return { slug, flag };
    }
    const entity = new AlgorithmProblemFlagEntity();
    entity.userId = userId;
    entity.slug = slug;
    entity.flag = flag;
    await this.problemFlagModel.save(entity);
    return { slug, flag };
  }

  async getUserFlags(
    userId: string
  ): Promise<Record<string, 'favorite' | 'redo'>> {
    const rows = await this.problemFlagModel.find({ where: { userId } });
    const map: Record<string, 'favorite' | 'redo'> = {};
    for (const row of rows) {
      map[row.slug] = row.flag;
    }
    return map;
  }

  async importProblems(dataStr: string) {
    const items = JSON.parse(dataStr);
    if (!Array.isArray(items)) throw R.error('导入数据格式错误，应为数组');

    const results = [];
    for (const item of items) {
      const tagIds: number[] = [];
      if (item.tags && Array.isArray(item.tags)) {
        for (const tagName of item.tags) {
          const tag = await this.saveTag(tagName);
          tagIds.push(Number(tag.id));
        }
      }

      const existing = await this.problemModel.findOneBy({ slug: item.slug });
      const problemData: any = {
        title: item.title,
        slug: item.slug,
        difficulty: item.difficulty || 'easy',
        description: item.description || '',
        defaultCode: item.defaultCode ? JSON.stringify(item.defaultCode) : null,
        solution: item.solution || null,
        orderNum: item.orderNum || 0,
        status: item.status || 'draft',
        tagIds,
      };
      if (existing) {
        problemData.id = Number(existing.id);
      }

      const problem = await this.saveProblem(problemData);

      if (item.testCases && Array.isArray(item.testCases)) {
        await this.saveTestCases(Number(problem.id), item.testCases);
      }

      results.push({ slug: item.slug, id: problem.id });
    }

    return { imported: results.length, results };
  }
}
