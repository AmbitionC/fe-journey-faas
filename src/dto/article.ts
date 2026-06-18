import { Rule, RuleType } from '@midwayjs/validate';

const MODULE_ENUM = ['interview', 'knowledge', 'firstclass'];

export class NavListQueryDTO {
  @Rule(
    RuleType.string()
      .valid(...MODULE_ENUM)
      .required()
  )
  module: string;
}

export class ArticleActionDTO {
  @Rule(RuleType.string().max(100).required())
  articleKey: string;

  @Rule(
    RuleType.string()
      .valid(...MODULE_ENUM)
      .required()
  )
  module: string;

  @Rule(RuleType.string().max(255).optional())
  title?: string;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

export class ArticleStatsQueryDTO {
  @Rule(RuleType.string().max(100).required())
  articleKey: string;
}

export class UserActionsQueryDTO {
  @Rule(RuleType.string().max(100).required())
  articleKey: string;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

export class RecordViewDTO {
  @Rule(RuleType.string().max(100).required())
  articleKey: string;

  @Rule(
    RuleType.string()
      .valid(...MODULE_ENUM)
      .required()
  )
  module: string;

  @Rule(RuleType.string().max(255).optional())
  title?: string;
}

export class BatchArticleStatsQueryDTO {
  @Rule(RuleType.string().max(2000).required())
  articleKeys: string;
}

export class UserActionListQueryDTO {
  @Rule(
    RuleType.string()
      .valid(...MODULE_ENUM)
      .optional()
  )
  module?: string;

  @Rule(RuleType.number().integer().min(1).default(1).optional())
  page?: number;

  @Rule(RuleType.number().integer().min(1).max(50).default(20).optional())
  pageSize?: number;

  @Rule(RuleType.string().max(50).optional())
  userId?: string;
}

export class LeaderboardQueryDTO {
  @Rule(RuleType.string().max(20).required())
  module: string;

  @Rule(RuleType.string().max(50).allow('').optional())
  userId?: string;
}
