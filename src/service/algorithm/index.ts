import { Inject, Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import { AlgorithmProblemEntity } from '../../entity/algorithm/problem';
import { AlgorithmTestCaseEntity } from '../../entity/algorithm/testCase';
import { AlgorithmTagEntity } from '../../entity/algorithm/tag';
import { AlgorithmProblemTagEntity } from '../../entity/algorithm/problemTag';
import { AlgorithmSubmissionEntity } from '../../entity/algorithm/submission';
import { AlgorithmCodeDraftEntity } from '../../entity/algorithm/codeDraft';
import { Judge0ClientService } from './judge0Client';
import { R } from '../../common/base.error.utils';

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

  @Inject()
  judge0ClientService: Judge0ClientService;

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

    const problemIds = list.map(p => p.id);
    const tagsMap: Record<string, any[]> = {};
    if (problemIds.length) {
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
        if (tagMap[r.tagId]) tagsMap[r.problemId].push(tagMap[r.tagId]);
      }
    }

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

    return {
      ...problem,
      sampleCases: sampleCases.map(tc => ({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
      })),
      tags,
      relatedArticles: problem.relatedArticles || [],
    };
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

  async getProblemLists(): Promise<{ slug: string; title: string; problemSlugs: string[] }[]> {
    const LIST_META: Record<string, string> = {
      'campus-hot': '校招高频',
      'by-topic': '按知识点',
      agent: 'Agent 专项',
    };

    const problems = await this.problemModel.find({
      where: { status: 'published' },
      select: ['slug', 'listSlugs'],
    });

    const grouped: Record<string, string[]> = {};
    for (const p of problems) {
      const slugs: string[] = Array.isArray(p.listSlugs) ? p.listSlugs : [];
      for (const ls of slugs) {
        if (!grouped[ls]) grouped[ls] = [];
        grouped[ls].push(p.slug);
      }
    }

    return Object.entries(LIST_META).map(([slug, title]) => ({
      slug,
      title,
      problemSlugs: grouped[slug] || [],
    }));
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
