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

/**
 * /content/sync 增量同步请求体
 *
 * 两种使用方式：
 * 1. 传 beforeSha + afterSha → 服务端调 GitHub compare API 获取变更文件列表
 * 2. 传 files → 直接使用调用方提供的文件列表（测试/手动触发时用）
 */
export class SyncDTO {
  @Rule(RuleType.string().optional())
  beforeSha?: string;

  @Rule(RuleType.string().optional())
  afterSha?: string;

  @Rule(
    RuleType.array()
      .items(
        RuleType.object({
          path: RuleType.string().required(),
          status: RuleType.string().required(),
        })
      )
      .optional()
  )
  files?: Array<{ path: string; status: string }>;
}
