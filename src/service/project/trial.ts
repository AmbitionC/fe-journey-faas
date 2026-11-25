import * as crypto from 'crypto';

/**
 * 项目实战「在线试用」：网站后端只负责发票据，试用本身跑在独立函数 project-trial-brain 里
 * （代码来自 agent-journey-projects 仓库，见 runner/project-trial/README.md）。
 *
 * 票据 = base64url(JSON).HMAC-SHA256，试用函数用同一把密钥验签；两分钟有效、一次性。
 * 签发前在这里检查登录和每日次数，所以试用函数不需要知道用户体系。
 *
 * 试用函数有多个实例，「一次性」和「全站今天用了多少」只有这里知道，所以它开跑前来领一次票据（claim），
 * 跑完来报一次用量（usage）。两种消息都用同一把密钥签名，带 typ，和票据不能互相冒充。
 * 票据会到浏览器手里，所以里面不放用户标识（手机号），用户和票据编号的对应关系存在 Redis。
 */

export interface TrialProject {
  /** 试用函数里的场景名 */
  scenarios: string[];
  /** 会员每天能现场跑几次：按一次运行大约要花多少模型用量定 */
  memberDaily: number;
  /** 每个场景一次大约用多少 token：领票据时先按它占住全站额度，跑完换成实数 */
  tokenEstimate: Record<string, number>;
}

/** 已接入在线试用的项目。新增项目时在这里登记。 */
export const TRIAL_PROJECTS: Record<string, TrialProject> = {
  // store：小型电商后端的示例仓库（网站工作台的默认场景）；shop：最早的单文件购物车，部署冒烟还在用
  'general-agent': { scenarios: ['store', 'shop'], memberDaily: 10, tokenEstimate: { store: 60_000, shop: 30_000 } },
  // 现场跑一轮进化（第一级提示词 / 第三级配置），场景定义在 runner/project-trial/eval-evolve/trial/plugin.py
  'eval-evolve': { scenarios: ['evolve-prompt', 'evolve-config'], memberDaily: 2, tokenEstimate: { 'evolve-prompt': 800_000, 'evolve-config': 450_000 } },
  // 现场跑一轮完整的增长活动（卖点→人群→素材→审核→试投→归因→进化），场景定义在 runner/project-trial/ecom-growth/trial/plugin.py
  'ecom-growth': { scenarios: ['campaign'], memberDaily: 3, tokenEstimate: { campaign: 130_000 } },
};

/** 现场运行每次都要调真模型，只对会员开放；非会员看前端的示例回放（不经过后端）。次数按项目分开计 */
export function trialDailyLimit(project: TrialProject, member: boolean): number {
  return member ? project.memberDaily : 0;
}
export const TRIAL_TICKET_TTL_SEC = 120;

export function trialConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.PROJECT_TRIAL_URL && env.PROJECT_TRIAL_TICKET_SECRET);
}

export function signTrialTicket(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${mac}`;
}

/** 北京时间的日期，作为每日次数的分桶 */
export function trialDay(now: Date): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function trialQuotaKey(userId: string, now: Date, projectId: string): string {
  return `project:trial:${trialDay(now)}:${userId}:${projectId}`;
}

/** 全站每天用在现场运行上的 token 上限，到顶当天不再放行 */
export const TRIAL_TOKEN_DAILY_DEFAULT = 5_000_000;

export function trialTokenLimit(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.PROJECT_TRIAL_TOKEN_DAILY);
  return Number.isFinite(v) && v > 0 ? v : TRIAL_TOKEN_DAILY_DEFAULT;
}

/** 试用函数回调用的主函数地址；默认值与前端 getApiDomain、weekly-digest 用的是同一个 */
export function trialCallbackBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PROJECT_TRIAL_CALLBACK || 'https://fe-journey-main-ktantdfjcs.cn-hangzhou.fcapp.run').replace(/\/+$/, '');
}

/** 一次现场运行最长几分钟，2 小时足够它来领、来报 */
export const TRIAL_RUN_TTL_SEC = 7200;

export function trialTokenKey(now: Date): string {
  return `project:trial:tokens:${trialDay(now)}`;
}

/** 签发时存下：这张票据是谁的、哪个项目和场景 */
export function trialRunKey(jti: string): string {
  return `project:trial:run:${jti}`;
}

/** 领走时存下：占在哪一天、占了多少 */
export function trialClaimKey(jti: string): string {
  return `project:trial:claim:${jti}`;
}

export function trialDoneKey(jti: string): string {
  return `project:trial:done:${jti}`;
}

/** 验试用函数发来的消息；签名、类型、有效期任一不对返回 null */
export function openTrialMessage(
  token: unknown, typ: string, secret: string, nowSec: number,
): Record<string, any> | null {
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const at = token.lastIndexOf('.');
  if (at <= 0) return null;
  const body = token.slice(0, at);
  const mac = Buffer.from(token.slice(at + 1));
  const good = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('hex'));
  if (mac.length !== good.length || !crypto.timingSafeEqual(mac, good)) return null;
  let p: any;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object' || p.typ !== typ) return null;
  if (typeof p.jti !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.jti)) return null;
  return Number(p.exp) >= nowSec ? p : null;
}

/** 上报来的数值：非数、负数按 0，过大的截住 */
export function usageNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0;
}
