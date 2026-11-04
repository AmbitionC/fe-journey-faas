import { Provide, Inject, Scope, ScopeEnum, ILogger } from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { R } from '../../common/base.error.utils';
import { sendAlertMail } from '../../mcp/payNotify';

/**
 * Iris 成本闸（2026-11-04 运营分析第 1 期：11-03 15:39~15:54 共 21 次游客调用烧掉约 166 万 token，
 * 单次最大 50 万——伪造 X-Forwarded-For 换游客身份 + 请求里塞超长历史，两处都没有上限）。
 *
 * 三层，都与「按 IP 识别游客」无关，换多少个 IP 都绕不过：
 * 1. **输入裁剪** `clampMessages`：只收 user/assistant 两种角色（客户端塞的 system 一律丢掉），
 *    每条最多 MAX_MESSAGE_CHARS 字，总量最多 MAX_TOTAL_CHARS 字、最近 MAX_MESSAGES 条。
 *    正常一问一答几百字，最长的代码点评也就几千字；单次调用的输入因此被压在约 2 万 token 以内。
 * 2. **游客全站兜底**：所有游客合计每天最多 IRIS_GUEST_GLOBAL_DAILY 次、IRIS_GUEST_TOKEN_DAILY 个 token
 *    （正常日游客合计约 60 次、3 万 token，默认值留了十倍以上余量）。超了只挡游客，登录用户照常。
 * 3. **异常告警**：单次调用超过 ALERT_SINGLE_CALL_TOKENS、游客全站兜底被触发、全站当日 token
 *    超过 ALERT_DAILY_TOKENS 时发邮件给站长（同一类每天只发一次），并打 warn 日志。
 *
 * 阈值都可用同名环境变量覆盖；Redis 故障时 1、3 照常，2 放行（不因计数故障挡住所有游客）。
 */

export const MAX_MESSAGES = 30;
export const MAX_MESSAGE_CHARS = 10000;
export const MAX_TOTAL_CHARS = 30000;

const DEFAULTS = {
  IRIS_GUEST_GLOBAL_DAILY: 600,
  IRIS_GUEST_TOKEN_DAILY: 600000,
  ALERT_SINGLE_CALL_TOKENS: 60000,
  ALERT_DAILY_TOKENS: 2000000,
};

type Knob = keyof typeof DEFAULTS;

export function knob(
  name: Knob,
  env: Record<string, string | undefined> = process.env
): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS[name];
}

export interface ClampableMessage {
  role: string;
  content: any;
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n…（中间内容过长已省略）…\n${text.slice(
    -tail
  )}`;
}

/**
 * 裁剪对话历史：丢掉非 user/assistant 角色，每条截断，从最新往前收，总量到顶就停。
 * 最新一条用户消息一定保留（截断后），保证「问的问题」本身不被丢掉。
 */
export function clampMessages<T extends ClampableMessage>(
  messages: T[] | undefined | null
): T[] {
  if (!Array.isArray(messages)) return [];
  const ok = messages.filter(
    m =>
      m &&
      (m.role === 'user' || m.role === 'assistant') &&
      m.content !== undefined &&
      m.content !== null
  );
  const out: T[] = [];
  let total = 0;
  for (let i = ok.length - 1; i >= 0 && out.length < MAX_MESSAGES; i--) {
    const m = ok[i];
    const text = cut(
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      MAX_MESSAGE_CHARS
    );
    if (out.length && total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    out.unshift({ ...m, content: text });
  }
  // OpenAI 风格要求首条是 user：前面截掉之后若以 assistant 开头，丢掉它
  while (out.length > 1 && out[0].role !== 'user') out.shift();
  return out;
}

/** 结构化任务（算法提示 / 代码点评）里的长字段同样截断。 */
export function clampTask<T extends Record<string, any>>(task: T): T {
  if (!task || typeof task !== 'object') return task;
  const copy: Record<string, any> = { ...task };
  for (const k of Object.keys(copy)) {
    if (typeof copy[k] === 'string') copy[k] = cut(copy[k], MAX_MESSAGE_CHARS);
  }
  return copy as T;
}

export function bjDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function isGuest(userId: string): boolean {
  return !userId || String(userId).startsWith('guest:');
}

/** 最小 Redis 依赖（单测注入替身） */
export interface GuardStore {
  incr(key: string): Promise<number>;
  incrby(key: string, n: number): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<any>;
  set(key: string, value: string, ...args: any[]): Promise<any>;
}

export type AlertKind =
  | 'single_call'
  | 'guest_calls'
  | 'guest_tokens'
  | 'daily_tokens';

const DAY_TTL = 86400 + 3600;

@Provide()
@Scope(ScopeEnum.Singleton)
export class IrisGuardService {
  @Inject()
  redisService: RedisService;

  @Inject()
  logger: ILogger;

  /** 单测替身 */
  store: GuardStore | null = null;
  alert:
    | ((kind: AlertKind, subject: string, text: string) => Promise<void>)
    | null = null;
  env: Record<string, string | undefined> = process.env;
  now: () => Date = () => new Date();

  private s(): GuardStore {
    return this.store || (this.redisService as unknown as GuardStore);
  }

  private key(name: string) {
    return `iris:guard:${bjDay(this.now())}:${name}`;
  }

  private async bump(name: string, by = 1): Promise<number | null> {
    try {
      const s = this.s();
      const k = this.key(name);
      const n = by === 1 ? await s.incr(k) : await s.incrby(k, by);
      if (n === by) await s.expire(k, DAY_TTL);
      return n;
    } catch {
      return null;
    }
  }

  private async peek(name: string): Promise<number> {
    try {
      return Number(await this.s().get(this.key(name))) || 0;
    } catch {
      return 0;
    }
  }

  /** 同一类告警每天只发一次。 */
  async raise(
    kind: AlertKind,
    subject: string,
    text: string
  ): Promise<boolean> {
    try {
      this.logger?.warn?.('[iris-guard] %s %s', kind, subject);
    } catch {
      /* ignore */
    }
    let first = true;
    try {
      const ok = await this.s().set(
        this.key(`alert:${kind}`),
        '1',
        'EX',
        DAY_TTL,
        'NX'
      );
      first = !!ok;
    } catch {
      first = true;
    }
    if (!first) return false;
    const send =
      this.alert ||
      ((_k: AlertKind, sub: string, body: string) =>
        sendAlertMail(this.env, sub, body));
    await send(kind, subject, text).catch(() => undefined);
    return true;
  }

  /**
   * 游客调用前（含「猜你想问」辅助调用）：全站游客当日次数 / token 兜底。超了抛 RATE_LIMIT。
   * 登录用户直接放行（他们有自己的每日上限与点数）。
   */
  async guestPrecheck(userId: string): Promise<void> {
    if (!isGuest(userId)) return;
    const tokCap = knob('IRIS_GUEST_TOKEN_DAILY', this.env);
    const callCap = knob('IRIS_GUEST_GLOBAL_DAILY', this.env);
    const tokens = await this.peek('guest_tokens');
    let reason: AlertKind | null = null;
    if (tokens >= tokCap) reason = 'guest_tokens';
    else {
      const n = await this.bump('guest_calls');
      if (n !== null && n > callCap) reason = 'guest_calls';
    }
    if (!reason) return;
    await this.raise(
      reason,
      reason === 'guest_tokens'
        ? `游客 Iris 今日 token 已达兜底上限 ${tokCap}`
        : `游客 Iris 今日调用已达兜底上限 ${callCap} 次`,
      `游客 Iris 全站兜底已触发（${bjDay(
        this.now()
      )}）：今日游客 token ${tokens}，上限 ${tokCap}；次数上限 ${callCap}。\n` +
        '此后今天的游客提问会提示登录后再问，登录用户不受影响。\n' +
        '正常日游客合计约 60 次、3 万 token；触发多半是有人在刷，可用 ops-query 查 ai_usage_log 里 guest: 开头的记录。'
    );
    throw R.forbiddenError(
      'RATE_LIMIT:今天游客的免费提问名额已经用完了，登录后可以继续问（新用户送体验点数）'
    );
  }

  /** 每次上游返回 usage 后记账 + 异常告警（proxy.logUsage 调用）。 */
  async record(userId: string, module: string, tokens: number): Promise<void> {
    const t = Math.max(0, Math.round(Number(tokens) || 0));
    if (!t) return;
    const total = await this.bump('all_tokens', t);
    if (isGuest(userId)) await this.bump('guest_tokens', t);

    const single = knob('ALERT_SINGLE_CALL_TOKENS', this.env);
    if (t >= single) {
      await this.raise(
        'single_call',
        `Iris 单次调用 ${t} token（阈值 ${single}）`,
        `单次调用用量异常：${t} token，身份 ${
          isGuest(userId) ? '游客' : '登录用户'
        }，模块 ${module || '-'}。\n` +
          `输入已有长度上限（每条 ${MAX_MESSAGE_CHARS} 字 / 合计 ${MAX_TOTAL_CHARS} 字），再出现说明有别的入口没走裁剪。`
      );
    }
    const daily = knob('ALERT_DAILY_TOKENS', this.env);
    if (total !== null && total >= daily) {
      await this.raise(
        'daily_tokens',
        `Iris 今日全站 token 已超 ${daily}`,
        `今日（${bjDay(
          this.now()
        )}）Iris 全站已用 ${total} token，超过告警线 ${daily}。正常日约 5~10 万。`
      );
    }
  }
}
