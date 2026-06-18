import { Rule, RuleType } from '@midwayjs/validate';

const CONTENT_MODULES = ['interview', 'knowledge', 'firstclass'] as const;

export class TreeQueryDTO {
  @Rule(
    RuleType.string()
      .valid(...CONTENT_MODULES)
      .required()
  )
  module: string;
}

export class ArticleQueryDTO {
  @Rule(
    RuleType.string()
      .valid(...CONTENT_MODULES)
      .required()
  )
  module: string;

  /**
   * filePath 对扁平模块(firstclass)可为空字符串。
   * 普通模块必须有值（由业务层检验）。
   */
  @Rule(RuleType.string().allow('').optional())
  filePath?: string;

  @Rule(RuleType.string().min(1).max(200).required())
  key: string;
}

export class SaveArticleDTO {
  @Rule(
    RuleType.string()
      .valid(...CONTENT_MODULES)
      .required()
  )
  module: string;

  @Rule(RuleType.string().min(1).max(200).required())
  parentKey: string;

  /** filePath 对扁平模块可为空字符串 */
  @Rule(RuleType.string().allow('').optional())
  filePath?: string;

  @Rule(RuleType.string().min(1).max(200).required())
  key: string;

  @Rule(RuleType.string().min(1).max(200).required())
  label: string;

  @Rule(RuleType.string().allow('').optional())
  content?: string;

  @Rule(RuleType.array().items(RuleType.string()).optional())
  tags?: string[];

  @Rule(RuleType.number().integer().optional())
  currRank?: number;
}

export class DeleteArticleDTO {
  @Rule(
    RuleType.string()
      .valid(...CONTENT_MODULES)
      .required()
  )
  module: string;

  /** filePath 对扁平模块可为空字符串 */
  @Rule(RuleType.string().allow('').optional())
  filePath?: string;

  @Rule(RuleType.string().min(1).max(200).required())
  key: string;
}

export class TreeUpdateDTO {
  @Rule(
    RuleType.string()
      .valid(...CONTENT_MODULES)
      .required()
  )
  module: string;

  @Rule(RuleType.array().required())
  navData: any[];
}

export class UploadImageDTO {
  @Rule(RuleType.string().min(1).max(200).required())
  fileName: string;

  @Rule(RuleType.string().min(1).required())
  dataBase64: string;
}
