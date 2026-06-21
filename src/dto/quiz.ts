import { Rule, RuleType } from '@midwayjs/validate';

const MODULE_ENUM = ['interview', 'knowledge', 'firstclass'];

export class QuizListQueryDTO {
  @Rule(RuleType.string().valid(...MODULE_ENUM).required())
  module: string;

  @Rule(RuleType.string().max(100).required())
  articleKey: string;
}

export class QuizSubmitDTO {
  @Rule(RuleType.string().valid(...MODULE_ENUM).required())
  module: string;

  @Rule(RuleType.string().max(100).required())
  articleKey: string;

  @Rule(
    RuleType.array()
      .items(
        RuleType.object({
          questionId: RuleType.number().required(),
          answer: RuleType.array().items(RuleType.string().allow('')).required(),
        })
      )
      .required()
  )
  answers: { questionId: number; answer: string[] }[];

  @Rule(RuleType.number().optional())
  durationMs?: number;

  @Rule(RuleType.string().max(64).allow('').optional())
  userId?: string;
}

export class QuizSaveDTO {
  @Rule(RuleType.number().optional())
  id?: number;

  @Rule(RuleType.string().valid(...MODULE_ENUM).required())
  module: string;

  @Rule(RuleType.string().max(100).required())
  articleKey: string;

  @Rule(RuleType.string().valid('single', 'multi', 'blank', 'qa').required())
  type: string;

  @Rule(RuleType.string().required())
  stem: string;

  @Rule(RuleType.array().optional())
  options?: { key: string; text: string }[];

  @Rule(RuleType.array().items(RuleType.string().allow('')).optional())
  answer?: string[];

  @Rule(RuleType.string().allow('').optional())
  analysis?: string;

  @Rule(RuleType.number().valid(1, 2, 3).optional())
  difficulty?: number;

  @Rule(RuleType.string().valid('manual', 'ai').optional())
  source?: string;

  @Rule(RuleType.string().valid('draft', 'published', 'archived').optional())
  status?: string;

  @Rule(RuleType.array().items(RuleType.string()).optional())
  tags?: string[];

  @Rule(RuleType.number().optional())
  orderNum?: number;
}

export class QuizDeleteDTO {
  @Rule(RuleType.number().required())
  id: number;
}

export class QuizDetailQueryDTO {
  @Rule(RuleType.number().required())
  id: number;
}

export class QuizAdminListQueryDTO {
  @Rule(RuleType.string().valid(...MODULE_ENUM).optional())
  module?: string;

  @Rule(RuleType.string().max(100).allow('').optional())
  articleKey?: string;

  @Rule(RuleType.string().valid('draft', 'published', 'archived').allow('').optional())
  status?: string;

  @Rule(RuleType.string().max(100).allow('').optional())
  keyword?: string;

  @Rule(RuleType.number().integer().min(1).default(1).optional())
  page?: number;

  @Rule(RuleType.number().integer().min(1).max(100).default(20).optional())
  pageSize?: number;
}

export class ReviewDueQueryDTO {
  @Rule(RuleType.string().valid(...MODULE_ENUM).required())
  module: string;

  @Rule(RuleType.string().max(64).allow('').optional())
  userId?: string;
}
