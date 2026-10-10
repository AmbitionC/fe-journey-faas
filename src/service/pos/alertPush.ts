import { Provide, Inject } from '@midwayjs/core';
import { PosDbService } from './db';
import { PosDashboardService } from './dashboard';
import { AlertLevel, PosAlert, alertsToPush } from './alerts';
import { nowCN, todayCN } from './logic';

/**
 * 健康预警推送：算预警 → 与 pos_alert_state 比对去重 → 有新预警才在 GitHub Issue 追评（→ 邮件 / App 通知）。
 *
 * 推送通道借 invest-model 私有仓的 Issue（与每日投资计划同一路径）：
 *   POS_ALERT_GH_TOKEN  需要该仓 Issues 写权限（部署时取 INVEST_GH_PAT）
 *   POS_ALERT_REPO      默认 AmbitionC/invest-model
 *   POS_ALERT_ISSUE     默认 285（「🩺 健康预警」）
 * 令牌缺失时只更新状态、不推送，返回 reason。
 */
@Provide()
export class PosAlertService {
  @Inject()
  db: PosDbService;

  @Inject()
  dashboard: PosDashboardService;

  async current() {
    const h = await this.dashboard.health();
    return { alerts: h.alerts, deficit: h.deficit };
  }

  async push(opts: { dryRun?: boolean } = {}) {
    const today = todayCN();
    const hour = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
    const h = await this.dashboard.health(today, hour);
    const alerts: PosAlert[] = h.alerts;

    const rows = await this.db.q<any>('SELECT alert_key, level, active, last_pushed FROM pos_alert_state');
    const state = new Map<string, { level: AlertLevel; active: boolean; lastPushed: string | null }>(
      rows.map(r => [
        r.alert_key,
        { level: r.level, active: Number(r.active) === 1, lastPushed: r.last_pushed ? String(r.last_pushed) : null },
      ])
    );
    const toPush = alertsToPush(alerts, state, today);
    if (opts.dryRun) return { alerts, toPush: toPush.map(a => a.key), posted: false, reason: 'dry_run' };

    let posted = false;
    let reason: string | undefined;
    if (toPush.length) {
      // 评论由机器人账号发出，@ 本人才走「@mentions」通知通道发邮件（同 invest-model gh_notify）
      const mention = process.env.POS_ALERT_MENTION || process.env.LIVE_WATCH_MENTION || '@AmbitionC';
      const body = `${renderComment(today, hour, h.deficit, alerts, new Set(toPush.map(a => a.key)))}\n\n${mention}`;
      const r = await this.postComment(body);
      posted = r.ok;
      reason = r.reason;
    }

    // 状态：本次出现的置 active、刷新 last_seen；推送成功的记 last_pushed；没出现的置 inactive（解除不推送）
    const now = nowCN();
    const pushedKeys = new Set(posted ? toPush.map(a => a.key) : []);
    for (const a of alerts) {
      await this.db.exec(
        `INSERT INTO pos_alert_state (alert_key, level, title, active, first_seen, last_seen, last_pushed)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE level = VALUES(level), title = VALUES(title),
           first_seen = IF(active = 1, first_seen, VALUES(first_seen)), active = 1, last_seen = VALUES(last_seen),
           last_pushed = IF(VALUES(last_pushed) IS NULL, last_pushed, VALUES(last_pushed))`,
        [a.key, a.level, a.title.slice(0, 200), today, today, pushedKeys.has(a.key) ? now : null]
      );
    }
    const live = alerts.map(a => a.key);
    await this.db.exec(
      live.length
        ? `UPDATE pos_alert_state SET active = 0 WHERE active = 1 AND alert_key NOT IN (${live.map(() => '?').join(',')})`
        : 'UPDATE pos_alert_state SET active = 0 WHERE active = 1',
      live
    );
    // 带日期的一次性键留 30 天足够去重
    await this.db.exec(`DELETE FROM pos_alert_state WHERE active = 0 AND alert_key LIKE '%:%' AND last_seen < DATE_SUB(?, INTERVAL 30 DAY)`, [today]);

    return { alerts, toPush: toPush.map(a => a.key), posted, reason };
  }

  private async postComment(body: string): Promise<{ ok: boolean; reason?: string }> {
    const token = process.env.POS_ALERT_GH_TOKEN || '';
    const repo = process.env.POS_ALERT_REPO || 'AmbitionC/invest-model';
    const issue = process.env.POS_ALERT_ISSUE || '285';
    if (!token) return { ok: false, reason: 'no_token' };
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}/comments`, {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'fe-journey-pos-alert',
        },
        body: JSON.stringify({ body }),
      });
      return res.ok ? { ok: true } : { ok: false, reason: `github_${res.status}` };
    } catch (e: any) {
      return { ok: false, reason: String(e?.message || e).slice(0, 120) };
    }
  }
}

const fmt = (n: number) => n.toLocaleString('en-US');
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

/** 评论正文：头部一行昨天/近 7 天热量缺口，下面列全部当前预警（本次新增的加「新」）。 */
export function renderComment(
  today: string,
  hour: number,
  deficit: { yesterday: any; avg7: number | null; target: number },
  alerts: PosAlert[],
  fresh: Set<string>
): string {
  const [, m, d] = today.split('-').map(Number);
  const lines = [`### 🩺 ${m}月${d}日 ${hour < 12 ? '早' : '晚'}`];
  const y = deficit.yesterday;
  const parts: string[] = [];
  if (y?.complete) parts.push(`昨天缺口 ${signed(y.deficit)} kcal（摄入 ${fmt(y.intake)} · 消耗 ${fmt(y.burn)}）`);
  if (deficit.avg7 != null) parts.push(`近 7 天均 ${signed(deficit.avg7)}（目标 ${deficit.target}）`);
  if (parts.length) lines.push('', parts.join('　|　'));
  lines.push('');
  for (const a of alerts) {
    const icon = a.level === 'red' ? '🔴' : '🟠';
    lines.push(`- ${icon} ${fresh.has(a.key) ? '**' + a.title + '**' : a.title}${a.detail ? ` — ${a.detail}` : ''}`);
  }
  return lines.join('\n');
}
