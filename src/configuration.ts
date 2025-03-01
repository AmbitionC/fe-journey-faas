import { Configuration, ILifeCycle, App } from '@midwayjs/core';
import * as faas from '@midwayjs/faas';
import * as redis from '@midwayjs/redis';
import * as cache from '@midwayjs/cache';
import * as captcha from '@midwayjs/captcha';
import * as swagger from '@midwayjs/swagger';
import * as orm from '@midwayjs/typeorm';
import * as defaultConfig from './config/config.default';
import * as prodConfig from './config/config.prod';
import { AuthMiddleware } from './middleware/auth';
import { CommonErrorFilter } from './filter/common';
import { DefaultErrorFilter } from './filter/default';
import { ValidateErrorFilter } from './filter/validate';

@Configuration({
  imports: [
    faas,
    redis,
    cache,
    captcha,
    orm,
    {
      component: swagger,
      enabledEnvironment: ['local'],
    },
  ],
  importConfigs: [
    {
      default: defaultConfig,
      prod: prodConfig,
    },
  ],
  conflictCheck: true,
})
export class MainConfiguration implements ILifeCycle {
  @App()
  app: faas.Application;

  async onReady() {
    console.log('Swagger UI path:', this.app.getConfig('swagger.swaggerPath'));
    this.app.useMiddleware(AuthMiddleware);
    this.app.useFilter([
      CommonErrorFilter,
      DefaultErrorFilter,
      ValidateErrorFilter,
    ]);
  }
}
