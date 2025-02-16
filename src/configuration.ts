import { Configuration, ILifeCycle, App } from '@midwayjs/core';
import * as faas from '@midwayjs/faas';
import * as redis from '@midwayjs/redis';
import * as cache from '@midwayjs/cache';
import * as captcha from '@midwayjs/captcha';
import * as orm from '@midwayjs/typeorm';
import * as defaultConfig from './config/config.default';
import * as prodConfig from './config/config.prod';
import { AuthMiddleware } from './middleware/auth';

@Configuration({
  imports: [faas, redis, cache, captcha, orm],
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
    this.app.useMiddleware(AuthMiddleware);
  }
}
