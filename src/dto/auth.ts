import { Rule, RuleType } from '@midwayjs/validate';

export class LoginDTO {
  @Rule(RuleType.string().required())
  accountNumber: string;

  @Rule(RuleType.string().required())
  password: string;

  @Rule(RuleType.string().required())
  captchaId: string;

  @Rule(RuleType.string().required())
  captcha: string;
}
