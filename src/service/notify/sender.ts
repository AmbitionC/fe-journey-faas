/**
 * 邮件发送（PRD-06）。懒加载 nodemailer，SMTP 配置走环境变量；
 * 缺配置/缺依赖时安全跳过（返回 sent:false），绝不抛错影响主流程。
 *
 * 环境变量：DM_SMTP_USER / DM_SMTP_PASS [/ DM_SMTP_HOST，默认 smtpdm.aliyun.com]（deploy.yml 已注入），
 * 兼容旧的 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM。
 */
export interface SendResult {
  sent: boolean;
  reason?: string;
}

export async function sendEmail(p: {
  to: string;
  subject: string;
  html: string;
}): Promise<SendResult> {
  // 线上只配了阿里云邮件推送（DM_SMTP_*，与收款提醒、告警同一发信地址），旧的 SMTP_* 作兼容
  const env = process.env;
  const user = env.DM_SMTP_USER || env.SMTP_USER;
  const pass = env.DM_SMTP_PASS || env.SMTP_PASS;
  const host = env.DM_SMTP_HOST || env.SMTP_HOST || (env.DM_SMTP_USER ? 'smtpdm.aliyun.com' : '');
  const port = Number(env.DM_SMTP_PORT || env.SMTP_PORT || 465);
  const from = env.SMTP_FROM || (user ? `Agent Journey <${user}>` : user);
  if (!host || !user || !pass) return { sent: false, reason: 'no_smtp_config' };

  try {
    // 懒加载，未安装/未配置时不影响其它功能
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    await transporter.sendMail({ from, to: p.to, subject: p.subject, html: p.html });
    return { sent: true };
  } catch (e: any) {
    return { sent: false, reason: e?.message || 'send_failed' };
  }
}
