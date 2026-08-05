import { Configuration, ILifeCycle, App } from '@midwayjs/core';
import * as faas from '@midwayjs/faas';
import * as redis from '@midwayjs/redis';
import * as cache from '@midwayjs/cache';
import * as captcha from '@midwayjs/captcha';
import * as swagger from '@midwayjs/swagger';
import * as orm from '@midwayjs/typeorm';
import * as crossDomain from '@midwayjs/cross-domain';
import * as defaultConfig from './config/config.default';
import { AuthMiddleware } from './middleware/auth';
import { CommonErrorFilter } from './filter/common';
import { DefaultErrorFilter } from './filter/default';
import { AuthErrorFilter } from './filter/auth';
import { ValidateErrorFilter } from './filter/validate';
import { seedSwordOffer } from './bootstrap/seedSwordOffer';
import { ensureInvestAdmin } from './bootstrap/ensureInvestAdmin';

@Configuration({
  imports: [
    faas,
    redis,
    cache,
    captcha,
    orm,
    crossDomain,
    {
      component: swagger,
      enabledEnvironment: ['local'],
    },
  ],
  importConfigs: [
    {
      default: defaultConfig,
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
      // AuthErrorFilter 必须在 DefaultErrorFilter 之前：后者是 @Catch() 通配，
      // 会把 401/403 也吞成 HTTP 200，前端因此收不到「该跳登录」的信号。
      AuthErrorFilter,
      CommonErrorFilter,
      DefaultErrorFilter,
      ValidateErrorFilter,
    ]);

    // 幂等导入剑指 Offer 题库(仅首次冷启动实际写入；自带 try/catch，不阻断启动)。
    await seedSwordOffer(this.app.getApplicationContext());

    // 幂等提升投资驾驶舱管理员(自带 try/catch，不阻断启动)。
    await ensureInvestAdmin(this.app.getApplicationContext());
  }
}
