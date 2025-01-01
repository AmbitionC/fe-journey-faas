import { Configuration, ILifeCycle } from '@midwayjs/core';
import * as faas from '@midwayjs/faas';
import * as redis from '@midwayjs/redis';
import * as cache from '@midwayjs/cache';
import * as captcha from '@midwayjs/captcha';
import * as defaultConfig from './config/config.default';
import * as prodConfig from './config/config.prod';

@Configuration({
  imports: [faas, redis, cache, captcha],
  importConfigs: [
    {
      default: defaultConfig,
      prod: prodConfig,
    },
  ],
  conflictCheck: true,
})
export class MainConfiguration implements ILifeCycle {
  async onReady() {}
}
