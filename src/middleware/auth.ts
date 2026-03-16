import {
  Middleware,
  IMiddleware,
  Inject,
  MidwayWebRouterService,
  RouterInfo,
  Config,
  NextFunction,
} from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { R } from '../common/base.error.utils';

@Middleware()
export class AuthMiddleware implements IMiddleware<any, NextFunction> {
  @Inject()
  redisService: RedisService;
  @Inject()
  webRouterService: MidwayWebRouterService;
  @Config('koa.globalPrefix')
  globalPrefix: string;
  @Inject()
  noAuthRouters: RouterInfo[];

  resolve() {
    return async (ctx: any, next: NextFunction) => {
      const routerInfo = await this.webRouterService.getMatchedRouterInfo(
        `${this.globalPrefix}${ctx.path}`,
        ctx.method
      );

      if (!routerInfo) return next();

      if (
        this.noAuthRouters.some(
          request =>
            request.requestMethod === routerInfo.requestMethod &&
            request.url === routerInfo.url
        )
      ) {
        console.log('routerInfo -->', routerInfo);
        await next();
        return;
      }

      const token =
        ctx.header.token ||
        ctx.header.authorization?.replace('Bearer ', '');
      if (!token) throw R.unauthorizedError('未登录');

      const userInfoStr = await this.redisService.get(`token:${token}`);
      if (!userInfoStr) throw R.unauthorizedError('未获取到用户信息');

      const userInfo = JSON.parse(userInfoStr);
      ctx.userInfo = userInfo;
      ctx.token = token;

      return next();
    };
  }

  static getName(): string {
    return 'auth';
  }
}
