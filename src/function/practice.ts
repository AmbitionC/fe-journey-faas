import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { RedisService } from '@midwayjs/redis';
import { R } from '../common/base.error.utils';
import { resolveUserInfo } from '../common/admin.guard';
import {
  PRACTICE_MODULES,
  mergeState,
  sanitizeState,
  stateKey,
} from '../service/practice/state';

/**
 * 备考库做题记录同步（央国企 / 考公）：文章内练习、整卷模考、错题本。
 * 只认登录态身份，不接受 body 里的 userId。
 */
@Provide()
export class PracticeHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  redisService: RedisService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '备考库：合并保存做题记录，返回合并后的结果（传空状态即只读）',
    functionName: 'practiceSync',
    name: 'practiceSync',
    path: '/practice/sync',
    method: 'post',
  })
  async sync(@Body(ALL) body: { module?: unknown; state?: unknown }) {
    const info = await resolveUserInfo(this.ctx, this.redisService);
    if (!info?.userId) throw R.unauthorizedError('请先登录');
    const module = body?.module;
    if (typeof module !== 'string' || !PRACTICE_MODULES.includes(module))
      throw R.validateError('不支持的模块');

    const key = stateKey(module, info.userId);
    let stored: unknown = null;
    try {
      const raw = await this.redisService.get(key);
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      stored = null;
    }
    const merged = mergeState(
      sanitizeState(stored),
      sanitizeState(body?.state)
    );
    await this.redisService.set(key, JSON.stringify(merged));
    return { success: true, data: merged };
  }
}
