import { Rule, RuleType } from '@midwayjs/validate';

const MODULE_ENUM = ['interview', 'knowledge', 'firstclass'];

export class CreateAnnotationDTO {
  @Rule(RuleType.string().max(100).required())
  articleKey: string;

  @Rule(
    RuleType.string()
      .valid(...MODULE_ENUM)
      .required()
  )
  module: string;

  @Rule(RuleType.string().valid('highlight', 'note').required())
  type: string;

  @Rule(RuleType.string().max(2000).required())
  selectedText: string;

  @Rule(RuleType.string().max(200).allow('').default(''))
  prefixText: string;

  @Rule(RuleType.string().max(200).allow('').default(''))
  suffixText: string;

  @Rule(RuleType.string().max(5000).optional().allow('', null))
  noteContent?: string;
}

export class QueryAnnotationsDTO {
  @Rule(RuleType.string().max(100).required())
  articleKey: string;

  @Rule(
    RuleType.string()
      .valid(...MODULE_ENUM)
      .required()
  )
  module: string;
}

export class DeleteAnnotationDTO {
  @Rule(RuleType.number().integer().required())
  id: number;
}
