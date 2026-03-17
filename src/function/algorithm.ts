import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { AlgorithmService } from '../service/algorithm/index';
import { NoAuth } from '../decorator/noAuth';
import {
  ProblemListQueryDTO,
  ProblemDetailQueryDTO,
  RunCodeDTO,
  SubmitCodeDTO,
  SubmissionListQueryDTO,
  SaveProblemDTO,
  DeleteProblemDTO,
  SaveTestCaseDTO,
  SaveTagDTO,
  ImportProblemsDTO,
  SaveDraftDTO,
  GetDraftDTO,
  LastResultQueryDTO,
} from '../dto/algorithm';

@Provide()
export class AlgorithmHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  algorithmService: AlgorithmService;

  // ========== 用户端 ==========

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取算法题目列表',
    functionName: 'getAlgoProblems',
    name: 'getAlgoProblems',
    path: '/algorithm/problems',
    method: 'get',
  })
  @NoAuth()
  async getProblems(@Query(ALL) query: ProblemListQueryDTO) {
    const data = await this.algorithmService.getProblems(query);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取算法题目详情',
    functionName: 'getAlgoProblemDetail',
    name: 'getAlgoProblemDetail',
    path: '/algorithm/problem/detail',
    method: 'get',
  })
  @NoAuth()
  async getProblemDetail(@Query(ALL) query: ProblemDetailQueryDTO) {
    const data = await this.algorithmService.getProblemDetail(query.slug);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取标签列表',
    functionName: 'getAlgoTags',
    name: 'getAlgoTags',
    path: '/algorithm/tags',
    method: 'get',
  })
  @NoAuth()
  async getTags() {
    const data = await this.algorithmService.getTags();
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '运行代码（仅示例用例）',
    functionName: 'runAlgoCode',
    name: 'runAlgoCode',
    path: '/algorithm/run',
    method: 'post',
  })
  async runCode(@Body(ALL) body: RunCodeDTO) {
    const userId = body.userId || this.ctx.userInfo?.userId;
    const data = await this.algorithmService.runCode({ ...body, userId });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '提交代码（全部用例）',
    functionName: 'submitAlgoCode',
    name: 'submitAlgoCode',
    path: '/algorithm/submit',
    method: 'post',
  })
  async submitCode(@Body(ALL) body: SubmitCodeDTO) {
    const userId = body.userId || this.ctx.userInfo?.userId;
    const data = await this.algorithmService.submitCode({
      ...body,
      userId,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取提交记录',
    functionName: 'getAlgoSubmissions',
    name: 'getAlgoSubmissions',
    path: '/algorithm/submissions',
    method: 'get',
  })
  async getSubmissions(@Query(ALL) query: SubmissionListQueryDTO) {
    const userId = query.userId || this.ctx.userInfo?.userId;
    const data = await this.algorithmService.getSubmissions({
      ...query,
      userId,
    });
    return { success: true, data };
  }

  // ========== 草稿与最近结果 ==========

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存代码草稿',
    functionName: 'saveAlgoDraft',
    name: 'saveAlgoDraft',
    path: '/algorithm/draft/save',
    method: 'post',
  })
  async saveDraft(@Body(ALL) body: SaveDraftDTO) {
    const userId = body.userId || this.ctx.userInfo?.userId;
    const data = await this.algorithmService.saveDraft({
      ...body,
      userId,
    });
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取代码草稿',
    functionName: 'getAlgoDraft',
    name: 'getAlgoDraft',
    path: '/algorithm/draft',
    method: 'get',
  })
  async getDraft(@Query(ALL) query: GetDraftDTO) {
    const userId = query.userId || this.ctx.userInfo?.userId;
    const data = await this.algorithmService.getDrafts(userId, query.problemId);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取最近一次运行/提交结果',
    functionName: 'getAlgoLastResult',
    name: 'getAlgoLastResult',
    path: '/algorithm/lastResult',
    method: 'get',
  })
  async getLastResult(@Query(ALL) query: LastResultQueryDTO) {
    const userId = query.userId || this.ctx.userInfo?.userId;
    const data = await this.algorithmService.getLastResult(
      userId,
      query.problemId
    );
    return { success: true, data };
  }

  // ========== 管理端 ==========

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '创建/更新题目',
    functionName: 'saveAlgoProblem',
    name: 'saveAlgoProblem',
    path: '/algorithm/problem/save',
    method: 'post',
  })
  async saveProblem(@Body(ALL) body: SaveProblemDTO) {
    const data = await this.algorithmService.saveProblem(body);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除题目',
    functionName: 'deleteAlgoProblem',
    name: 'deleteAlgoProblem',
    path: '/algorithm/problem/delete',
    method: 'post',
  })
  async deleteProblem(@Body(ALL) body: DeleteProblemDTO) {
    const data = await this.algorithmService.deleteProblem(body.id);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '批量保存测试用例',
    functionName: 'saveAlgoTestCases',
    name: 'saveAlgoTestCases',
    path: '/algorithm/testcase/save',
    method: 'post',
  })
  async saveTestCases(@Body(ALL) body: SaveTestCaseDTO) {
    const data = await this.algorithmService.saveTestCases(
      body.problemId,
      body.testCases
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '创建标签',
    functionName: 'saveAlgoTag',
    name: 'saveAlgoTag',
    path: '/algorithm/tag/save',
    method: 'post',
  })
  async saveTag(@Body(ALL) body: SaveTagDTO) {
    const data = await this.algorithmService.saveTag(body.name);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '批量导入题目',
    functionName: 'importAlgoProblems',
    name: 'importAlgoProblems',
    path: '/algorithm/import',
    method: 'post',
  })
  async importProblems(@Body(ALL) body: ImportProblemsDTO) {
    const data = await this.algorithmService.importProblems(body.data);
    return { success: true, data };
  }
}
