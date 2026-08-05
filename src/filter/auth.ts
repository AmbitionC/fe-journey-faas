import { Catch, httpError, MidwayHttpError } from '@midwayjs/core';
import { Context } from '@midwayjs/faas';

/**
 * 鉴权错误过滤器（2026-08-05 修复「进站显示未获取到用户信息、却不跳登录」）。
 *
 * 症结：`DefaultErrorFilter` 用 `@Catch()` 兜住了**所有**未分类错误，包括
 * AuthMiddleware 抛的 `httpError.UnauthorizedError`，而它只返回
 * `{ success:false, message }` **没有设置 ctx.status** ⟹ 响应是 HTTP 200。
 * 前端 `app.ts` 的 errorHandler 只在 `status === 401` 时清 token 跳登录，
 * 200 走不到那条分支，只被 responseInterceptor 弹了一句 toast ——
 * 于是 token 过期后页面卡在「未获取到用户信息」，永远等不到登录引导。
 *
 * 修法：把这两类鉴权错误单独接出来，按语义回真实状态码。
 * `@Catch` 取最具体的匹配，因此这里只改 401/403，其余错误的行为一字不动。
 */
@Catch([httpError.UnauthorizedError, httpError.ForbiddenError])
export class AuthErrorFilter {
  async catch(err: MidwayHttpError, ctx: Context) {
    const status = Number(err.status) || 401;
    ctx.status = status;
    return { success: false, code: status, message: err.message };
  }
}
