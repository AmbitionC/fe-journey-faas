import { createHmac, timingSafeEqual } from 'crypto';

/**
 * 每周学习邮件（复习提醒 + 周报）的纯函数：正文渲染与一键退订签名。
 * 发送与定时在 service/notify 与 .github/workflows/weekly-digest.yml。
 */
export const SITE = 'https://www.agent-journey.cn';
export const API_BASE = 'https://fe-journey-main-ktantdfjcs.cn-hangzhou.fcapp.run';

export function unsubscribeSig(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(`notify-unsub:${userId}`).digest('hex').slice(0, 32);
}

export function verifyUnsubscribe(secret: string | undefined, userId: string, sig: string): boolean {
  if (!secret || !userId || !sig) return false;
  const want = Buffer.from(unsubscribeSig(secret, userId));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function unsubscribeUrl(secret: string | undefined, userId: string): string {
  if (!secret) return `${SITE}/profile`;
  return `${API_BASE}/notify/unsubscribe/link?u=${encodeURIComponent(userId)}&s=${unsubscribeSig(secret, userId)}`;
}

const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface DigestMailInput {
  weekly?: string;
  streak?: number;
  reviewDue: { articleKey: string; reason: string }[];
  titles: Map<string, { title: string }>;
  unsubscribe: string;
}

export function renderDigestHtml(d: DigestMailInput): string {
  const items = d.reviewDue
    .map(r => {
      const title = d.titles.get(r.articleKey)?.title || r.articleKey;
      const url = `${SITE}/knowledge?activeKey=${encodeURIComponent(r.articleKey)}`;
      return `<li style="margin:6px 0"><a href="${url}" style="color:#2f6b4f">${esc(title)}</a><span style="color:#888"> · ${esc(r.reason)}</span></li>`;
    })
    .join('');
  return `<div style="font-family:-apple-system,'PingFang SC',sans-serif;max-width:560px;line-height:1.7;color:#222">
  <h2 style="font-size:18px">这周该复习的知识点</h2>
  ${d.weekly ? `<p>${esc(d.weekly)}</p>` : ''}
  ${d.streak ? `<p>你已经连续学习 <b>${d.streak}</b> 天。</p>` : ''}
  ${items ? `<ul style="padding-left:18px">${items}</ul>` : '<p>这周没有到期要复习的内容。</p>'}
  <p><a href="${SITE}/knowledge" style="color:#2f6b4f">打开 Agent Journey 接着学</a></p>
  <p style="color:#999;font-size:12px">你在 Agent Journey 订阅了每周学习提醒。<a href="${d.unsubscribe}" style="color:#999">不想再收到，点这里退订</a>。</p>
</div>`;
}
