import { Catch } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { CommonError } from '../common/common.error';

@Catch(CommonError)
export class CommonErrorFilter {
  async catch(err: CommonError, ctx: Context) {
    // 未捕获的错误，是系统错误，错误码是500
    ctx.status = 400;
    return {
      code: 400,
      message: err.message,
    };
  }
}
