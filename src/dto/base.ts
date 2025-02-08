import { Rule, RuleType } from '@midwayjs/validate';
import { omit } from 'lodash';
import { BaseEntity } from '../entity/base';

export class BaseDTO<T extends BaseEntity> {
  @Rule(RuleType.allow(null))
  id: string;
  toEntity(): T {
    return omit(this, ['createDate', 'updateDate']) as unknown as T;
  }
}
