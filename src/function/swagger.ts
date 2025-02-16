import { Provide, Inject, Get, Controller } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';

@Provide()
@Controller('/')
export class SwaggerHTTPService {
  @Inject()
  ctx: Context;

  @Get('/swagger-ui')
  @Get('/swagger-ui/*')
  async handler() {
    console.log('swagger-ui');
  }
}
