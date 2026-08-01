import {
  Middleware,
  IMiddleware,
  Inject,
  NextFunction,
} from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { R } from '../common/base.error.utils';

/**
 * 鉴权中间件（2026-08-01 重写）。
 *
 * 历史问题：旧实现用 `getMatchedRouterInfo(`${globalPrefix}${ctx.path}`)` 判定路由，
 * 但 koa.globalPrefix 从未配置（undefined），拼出的查询路径恒不匹配 → routerInfo
 * 恒为 null → 旧代码 `if (!routerInfo) return next()` 把**所有请求**放行——
 * 平台级 token 鉴权在生产从未真正生效，全部端点事实匿名可达，真实防线只有
 * 写接口内的 assertAdmin。
 *
 * 现行为：
 * - `/invest/*`：强制 token + admin（个人持仓/资产/计划，60 个端点统一切面）。
 * - 其他路径：维持平台历史事实行为（放行），仅尽力解析 token 挂到 ctx.userInfo
 *   供下游 assertAdmin 等使用。全局收紧须先盘点主站哪些端点必须游客可达
 *   （面试/题库公开页），属产品决策，不在本次安全修复内静默切换。
 * - OPTIONS 预检直接放行（不携带自定义头，CORS 由 cross-domain 组件处理）。
 */
@Middleware()
export class AuthMiddleware implements IMiddleware<any, NextFunction> {
  @Inject()
  redisService: RedisService;

  resolve() {
    return async (ctx: any, next: NextFunction) => {
      if (String(ctx.method).toUpperCase() === 'OPTIONS') return next();

      const token =
        ctx.header.token ||
        ctx.header.authorization?.replace('Bearer ', '');

      const isInvest = String(ctx.path || '').startsWith('/invest');
      if (!isInvest) {
        // 尽力解析登录态，不改变非 invest 端点的可达性（见类注释）。
        if (token) {
          try {
            const s = await this.redisService.get(`token:${token}`);
            if (s) {
              ctx.userInfo = JSON.parse(s);
              ctx.token = token;
            }
          } catch {
            // 解析失败视为未登录，不阻断
          }
        }
        return next();
      }

      // /invest/*：强制登录 + admin（@NoAuth 声明对 invest 路径同样不豁免）
      if (!token) throw R.unauthorizedError('未登录');
      const userInfoStr = await this.redisService.get(`token:${token}`);
      if (!userInfoStr) throw R.unauthorizedError('未获取到用户信息');
      const userInfo = JSON.parse(userInfoStr);
      if (userInfo.role !== 'admin') {
        throw R.unauthorizedError('需要管理员权限');
      }
      ctx.userInfo = userInfo;
      ctx.token = token;
      return next();
    };
  }

  static getName(): string {
    return 'auth';
  }
}
