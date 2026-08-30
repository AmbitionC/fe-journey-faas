import {
  Middleware,
  IMiddleware,
  Inject,
  Config,
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

  @Config('token')
  tokenConfig: { expire: number };

  /** 绝对会话寿命（秒）：活跃续期最多把一个会话延到登录后 30 天，之后须重新登录。
   * 没有它，被窃 token 只要每 7 天请求一次即可永久有效（2026-08-30 审查 P2-2）。 */
  static readonly ABSOLUTE_MAX_AGE = 60 * 60 * 24 * 30;

  /**
   * 滑动续期：登录态只在登录时写一次、TTL 7 天，此前无任何续期 ⟹ 活跃用户也会在
   * 第 7 天整点被集体登出（2026-08-28 晨两位用户同时 401、整站「请求失败」的根因①）。
   * 每次带有效 token 的请求都把 TTL 重置为完整周期：活跃即不掉线，闲置 7 天才过期。
   * 失败静默——续期挂掉不应影响本次请求。
   *
   * 绝对寿命：伴生键 `token:<t>:iat` 记录首次见到该 token 的时间（对既有会话从
   * 本次部署起计），会话年龄超过 ABSOLUTE_MAX_AGE 后不再续期——闲置 TTL 自然
   * 走完即登出；不主动删 key，避免把正在处理的请求打断。
   */
  private renew(token: string) {
    const expire = this.tokenConfig?.expire || 60 * 60 * 24 * 7;
    const iatKey = `token:${token}:iat`;
    (async () => {
      const now = Math.floor(Date.now() / 1000);
      // NX：只有第一次见到才写；EX 给伴生键比绝对寿命略长的 TTL 防泄漏残留
      const created = await this.redisService.set(
        iatKey, String(now), 'EX', AuthMiddleware.ABSOLUTE_MAX_AGE + expire, 'NX');
      if (!created) {
        const iat = Number(await this.redisService.get(iatKey));
        if (iat && now - iat > AuthMiddleware.ABSOLUTE_MAX_AGE) return; // 超绝对寿命：不续期
      }
      await this.redisService.expire(`token:${token}`, expire);
    })().catch(() => {});
  }

  /**
   * 主鉴权路径的同步超龄检查（2026-08-30 二次验收 P2-1）：只停续期不拒请求时，
   * 第 30 天前刚续过期的会话还能再用一个完整闲置 TTL（实际 ≈37 天）。超龄即删
   * 主 key 与伴生键并拒绝本次请求；Redis 异常按未超龄处理，不误伤正常请求。
   */
  private async sessionExpired(token: string): Promise<boolean> {
    try {
      const iat = Number(await this.redisService.get(`token:${token}:iat`));
      if (iat && Math.floor(Date.now() / 1000) - iat > AuthMiddleware.ABSOLUTE_MAX_AGE) {
        await Promise.resolve(
          this.redisService.del(`token:${token}`, `token:${token}:iat`),
        ).catch(() => {});
        return true;
      }
    } catch {
      // 读 iat 失败＝无法判定，放行走闲置 TTL 兜底
    }
    return false;
  }

  resolve() {
    return async (ctx: any, next: NextFunction) => {
      if (String(ctx.method).toUpperCase() === 'OPTIONS') return next();

      const token =
        ctx.header.token ||
        ctx.header.authorization?.replace('Bearer ', '');

      // toLowerCase：消除「路由不区分大小写而本判定区分」时 /INVEST/* 绕过鉴权的歧义（安全审计A）
      const isInvest = String(ctx.path || '').toLowerCase().startsWith('/invest');
      if (!isInvest) {
        // 尽力解析登录态，不改变非 invest 端点的可达性（见类注释）。
        if (token) {
          try {
            const s = await this.redisService.get(`token:${token}`);
            if (s && !(await this.sessionExpired(token))) {
              ctx.userInfo = JSON.parse(s);
              ctx.token = token;
              this.renew(token);
            }
          } catch {
            // 解析失败视为未登录，不阻断
          }
        }
        return next();
      }

      // /invest/*：强制登录（@NoAuth 声明对 invest 路径同样不豁免）。
      // 角色就两种（owner 2026-08-10 定，产品对外一期）：admin=owner 全量；
      // 普通用户只能读「市场级」四组只读数据——宽基状态/乖离率/恐慌/杠杆信号，
      // 其余（计划/持仓/投顾/复盘/套利/美股/模型…）一律 admin。
      // 名单外的新端点默认落到 admin 分支＝加功能忘配权限时只会更严不会泄露。
      if (!token) throw R.unauthorizedError('未登录');
      const userInfoStr = await this.redisService.get(`token:${token}`);
      if (!userInfoStr) throw R.unauthorizedError('未获取到用户信息');
      if (await this.sessionExpired(token)) throw R.unauthorizedError('登录已过期，请重新登录');
      const userInfo = JSON.parse(userInfoStr);
      ctx.userInfo = userInfo;
      ctx.token = token;
      this.renew(token);
      if (userInfo.role === 'admin') return next();
      const path = String(ctx.path || '').toLowerCase();
      const method = String(ctx.method).toUpperCase();
      const isMarketRead =
        method === 'GET' &&
        (path === '/invest/broad' ||
          path === '/invest/bias' ||
          path === '/invest/allweather' ||
          path === '/invest/leverage' ||
          path === '/invest/alerts/feed' ||     // 对外预警流（≠ /invest/alerts 个人盯盘，仍 admin）
          path === '/invest/macro' ||           // 宏观读数（市场级公开数据）
          path.startsWith('/invest/fear'));
      // 预警订阅设置：登录用户读写自己的（handler 只认 ctx.userInfo，不信任入参）
      // 注意 path 已 toLowerCase，字面量必须全小写（alertPref → alertpref）
      const isOwnPref =
        (path === '/invest/alertpref' && (method === 'GET' || method === 'POST')) ||
        // 个人记账：handler 只认登录态 userId，行级只读写自己的
        (path.startsWith('/invest/myledger') && (method === 'GET' || method === 'POST'));
      // 403 而非 401：前端对 401 一律跳登录，越权用 403 走普通错误提示（防登出循环）
      if (!isMarketRead && !isOwnPref) throw R.forbiddenError('需要管理员权限');
      return next();
    };
  }

  static getName(): string {
    return 'auth';
  }
}
