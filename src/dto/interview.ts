import { Rule, RuleType } from '@midwayjs/validate';
import { BaseDTO } from './base';
import { InterviewEntity } from '../entity/interview';
import { requiredString } from '../common/common.validate.rules';
import { R } from '../common/base.error.utils';

export class InterviewDTO extends BaseDTO<InterviewEntity> {
  @Rule(requiredString.error(R.validateError('标题不能为空')))
  title: string;

  @Rule(requiredString.error(R.validateError('内容不能为空')))
  content: string;

  @Rule(requiredString.error(R.validateError('URL不能为空')))
  url: string;

  @Rule(RuleType.string().allow(null, ''))
  author?: string;

  @Rule(RuleType.string().allow(null, ''))
  publishTime?: string;

  @Rule(RuleType.string().allow(null, ''))
  aiTitle?: string;

  @Rule(RuleType.string().allow(null, ''))
  aiContent?: string;

  @Rule(RuleType.string().allow(null, ''))
  status?: string;

  @Rule(RuleType.string().allow(null, ''))
  source?: string;
}
