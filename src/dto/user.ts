import { Rule, RuleType } from '@midwayjs/validate';
import { BaseDTO } from './base';
import { UserEntity } from '../entity/user';
import { R } from '../common/base.error.utils';
import { phone, requiredString } from '../common/common.validate.rules';

export class UserDTO extends BaseDTO<UserEntity> {
  @Rule(phone.error(R.validateError('无效的手机号格式')))
  phoneNumber: string;

  @Rule(requiredString.error(R.validateError('用户名称不能为空')))
  nickName: string;

  @Rule(requiredString.error(R.validateError('密码不能为空')))
  password: string;

  @Rule(RuleType.string())
  captchaId: string;

  @Rule(requiredString.error(R.validateError('验证码不能为空')))
  captcha: string;

  @Rule(RuleType.allow(null))
  isMember?: boolean;

  @Rule(RuleType.allow(null))
  memberDate?: string;

  /** 邀请码（好友分享链接 ?invite= 带来的，注册后双方得点；见 mcp/referral） */
  @Rule(RuleType.string().allow(null, '').max(32))
  inviteCode?: string;

  /** 邀请来自哪个产品（agent / invest / kids，见 mcp/referral REFERRAL_PROGRAMS）；不传按 agent */
  @Rule(RuleType.string().allow(null, '').max(16))
  referralProduct?: string;
}
