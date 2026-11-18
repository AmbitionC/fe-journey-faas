import * as crypto from 'crypto';

/**
 * 项目实战「在线试用」：网站后端只负责发票据，试用本身跑在独立函数 project-trial-brain 里
 * （代码来自 agent-journey-projects 仓库，见 runner/project-trial/README.md）。
 *
 * 票据 = base64url(JSON).HMAC-SHA256，试用函数用同一把密钥验签；两分钟有效、一次性。
 * 签发前在这里检查登录和每日次数，所以试用函数不需要知道用户体系。
 */

export interface TrialProject {
  /** 试用函数里的场景名 */
  scenarios: string[];
}

/** 已接入在线试用的项目。新增项目时在这里登记。 */
export const TRIAL_PROJECTS: Record<string, TrialProject> = {
  'general-agent': { scenarios: ['shop'] },
};

export const TRIAL_DAILY_LIMIT = { user: 3, member: 20 };
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

export function trialQuotaKey(userId: string, now: Date): string {
  return `project:trial:${trialDay(now)}:${userId}`;
}
