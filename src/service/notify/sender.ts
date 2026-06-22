/**
 * 邮件发送（PRD-06）。懒加载 nodemailer，SMTP 配置走环境变量；
 * 缺配置/缺依赖时安全跳过（返回 sent:false），绝不抛错影响主流程。
 *
 * 需要的环境变量（在 FC 函数环境变量配置）：
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
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
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  if (!host || !user || !pass) return { sent: false, reason: 'no_smtp_config' };

  try {
    // 懒加载，未安装/未配置时不影响其它功能
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user, pass },
    });
    await transporter.sendMail({ from, to: p.to, subject: p.subject, html: p.html });
    return { sent: true };
  } catch (e: any) {
    return { sent: false, reason: e?.message || 'send_failed' };
  }
}
