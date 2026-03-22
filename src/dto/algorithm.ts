import { Rule, RuleType } from '@midwayjs/validate';

const DIFFICULTY_ENUM = ['easy', 'medium', 'hard'];
const LANGUAGE_ENUM = ['javascript', 'typescript', 'python', 'c', 'cpp', 'java'];

// --- 用户端 ---

export class ProblemListQueryDTO {
  @Rule(RuleType.number().integer().min(1).default(1).optional())
  page?: number;

  @Rule(RuleType.number().integer().min(1).max(50).default(20).optional())
  pageSize?: number;

  @Rule(
    RuleType.string()
      .valid(...DIFFICULTY_ENUM)
      .optional()
  )
  difficulty?: string;

  @Rule(RuleType.number().integer().optional())
  tagId?: number;

  @Rule(RuleType.string().max(100).optional())
  keyword?: string;
}

export class ProblemDetailQueryDTO {
  @Rule(RuleType.string().max(100).required())
  slug: string;
}

export class RunCodeDTO {
  @Rule(RuleType.number().integer().required())
  problemId: number;

  @Rule(
    RuleType.string()
      .valid(...LANGUAGE_ENUM)
      .required()
  )
  language: string;

  @Rule(RuleType.string().max(50000).required())
  code: string;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

export class SubmitCodeDTO {
  @Rule(RuleType.number().integer().required())
  problemId: number;

  @Rule(
    RuleType.string()
      .valid(...LANGUAGE_ENUM)
      .required()
  )
  language: string;

  @Rule(RuleType.string().max(50000).required())
  code: string;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

export class SubmissionListQueryDTO {
  @Rule(RuleType.number().integer().required())
  problemId: number;

  @Rule(RuleType.number().integer().min(1).default(1).optional())
  page?: number;

  @Rule(RuleType.number().integer().min(1).max(50).default(20).optional())
  pageSize?: number;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

// --- 管理端 ---

export class SaveProblemDTO {
  @Rule(RuleType.number().integer().optional())
  id?: number;

  @Rule(RuleType.string().max(200).required())
  title: string;

  @Rule(RuleType.string().max(100).required())
  slug: string;

  @Rule(
    RuleType.string()
      .valid(...DIFFICULTY_ENUM)
      .required()
  )
  difficulty: string;

  @Rule(RuleType.string().max(100000).required())
  description: string;

  @Rule(RuleType.string().max(100000).optional())
  defaultCode?: string;

  @Rule(RuleType.string().max(100000).optional())
  solution?: string;

  @Rule(RuleType.number().integer().optional())
  orderNum?: number;

  @Rule(RuleType.string().valid('draft', 'published').optional())
  status?: string;

  @Rule(RuleType.array().items(RuleType.number().integer()).optional())
  tagIds?: number[];
}

export class DeleteProblemDTO {
  @Rule(RuleType.number().integer().required())
  id: number;
}

export class SaveTestCaseDTO {
  @Rule(RuleType.number().integer().required())
  problemId: number;

  @Rule(
    RuleType.array()
      .items(
        RuleType.object().keys({
          id: RuleType.number().integer().optional(),
          input: RuleType.string().max(50000).required(),
          expectedOutput: RuleType.string().max(50000).required(),
          isSample: RuleType.boolean().default(false),
          orderNum: RuleType.number().integer().default(0),
        })
      )
      .min(1)
      .required()
  )
  testCases: Array<{
    id?: number;
    input: string;
    expectedOutput: string;
    isSample?: boolean;
    orderNum?: number;
  }>;
}

export class SaveTagDTO {
  @Rule(RuleType.string().max(50).required())
  name: string;
}

export class ImportProblemsDTO {
  @Rule(RuleType.string().max(5000000).required())
  data: string;
}

export class ProblemStatusQueryDTO {
  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

// --- 草稿与运行记录 ---

export class SaveDraftDTO {
  @Rule(RuleType.number().integer().required())
  problemId: number;

  @Rule(
    RuleType.string()
      .valid(...LANGUAGE_ENUM)
      .required()
  )
  language: string;

  @Rule(RuleType.string().max(50000).required())
  code: string;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

export class GetDraftDTO {
  @Rule(RuleType.number().integer().required())
  problemId: number;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

export class LastResultQueryDTO {
  @Rule(RuleType.number().integer().required())
  problemId: number;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}
