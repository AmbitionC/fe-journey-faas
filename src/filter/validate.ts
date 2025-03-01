import { Catch } from '@midwayjs/core';
import { MidwayValidationError } from '@midwayjs/validate';
import { Context } from '@midwayjs/faas';

@Catch(MidwayValidationError)
export class ValidateErrorFilter {
  async catch(err: MidwayValidationError, ctx: Context) {
    // 未捕获的错误，是系统错误，错误码是500
    ctx.status = 422;
    return {
      code: 422,
      message: err.message,
    };
  }
}
