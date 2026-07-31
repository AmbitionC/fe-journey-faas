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

      // 未匹配到路由的请求不再放行：网关 authType=anonymous，应用层是唯一防线，
      // 放行未知路径等于给任何鉴权绕过留后门（原样 404 交给框架也会先过这里）。
      if (!routerInfo) throw R.unauthorizedError('未匹配路由');

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

      // /invest/* 全部端点（含只读）收敛为 admin-only：持仓/资产/计划属个人敏感数据，
      // 平台存量账号不应可读。写接口原有 assertAdmin 继续兜底，这里是统一切面。
      if (ctx.path.startsWith('/invest') && userInfo.role !== 'admin') {
        throw R.unauthorizedError('需要管理员权限');
      }

      return next();
    };
  }

  static getName(): string {
    return 'auth';
  }
}
