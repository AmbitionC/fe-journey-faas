/**
 * 本机自动化（牛客运营等）遇到要人处理的阻塞时发邮件提醒：复用运维告警发信
 * （sendAlertMail，收件人 PAY_NOTIFY_EMAIL）。只做校验与限流，发信失败不抛。
 */
export const OPS_ALERT_DAILY_LIMIT = 30;

export interface OpsAlertInput {
  subject: string;
  text: string;
}

/** 校验并规整请求体；不合法返回 undefined。 */
export function normalizeOpsAlert(body: any): OpsAlertInput | undefined {
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!subject || !text || subject.length > 120 || text.length > 4000) return undefined;
  return { subject: subject.replace(/[\r\n]+/g, ' '), text };
}

/** 北京时间当日计数键，按日限流防止循环刷邮件。 */
export function opsAlertCounterKey(now: Date): string {
  const day = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return `pos:opsAlert:${day}`;
}
