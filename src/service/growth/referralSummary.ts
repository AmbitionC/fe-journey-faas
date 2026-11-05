import type { QueryFn } from '../../mcp/store';
import { maskUser } from '../../mcp/referral';

/**
 * 邀请裂变漏斗汇总（2026-11-05 owner：「这个功能也要做好埋点」）。
 *
 * 漏斗（窗口内发生数，口径同 skillSummary：排除内部账号、时间用库内 NOW()、单项失败为 null 不伪造为零）：
 *   看到邀请卡 invite_card_view → 分享 invite_share（链接 / 二维码 / 文案）
 *   → 好友带码落地 invite_landing → 横幅曝光 / 点击 invite_banner_view / invite_banner_click
 *   → 建立邀请关系 referral 表（按入口 signup / sms / bind、按产品、计奖 / 冻结原因）
 *   → 好友开会员 referral.member_reward_at
 * 另出：发出去的会员天数与点数（看权益成本）、无效码 / 互邀等被拒次数、Top 邀请人（脱敏）。
 * 前端事件在 event_log（游客 userId 为 guest:ip），后端事件在 mcp_event。只出计数，不出号码。
 */
export async function referralSummary(
  q: QueryFn,
  days: number,
  exclude: string[]
) {
  const d = Math.max(1, Math.min(180, Math.floor(days) || 7));
  const ex = (exclude || []).filter(Boolean);
  const notIn = (col: string) =>
    ex.length
      ? ` AND (${col} IS NULL OR ${col} NOT IN (${ex
          .map(() => '?')
          .join(',')}))`
      : '';
  const win = (col: string) => `${col} >= DATE_SUB(NOW(), INTERVAL ? DAY)`;
  const rows = async (
    sql: string,
    params: any[]
  ): Promise<Record<string, any>[] | null> => {
    try {
      return (await q(sql, params)) || [];
    } catch {
      return null;
    }
  };
  const n = (v: any) => Number(v || 0);

  const WEB_EVENTS = [
    'invite_card_view',
    'invite_share',
    'invite_landing',
    'invite_banner_view',
    'invite_banner_click',
    'invite_bind',
  ];

  const [web, shareVia, signups, byVia, byProduct, paid, rejected, top] =
    await Promise.all([
      rows(
        `SELECT event, COUNT(*) AS count, COUNT(DISTINCT userId) AS users FROM event_log
        WHERE event IN (${WEB_EVENTS.map(() => '?').join(',')}) AND ${win(
          'createTime'
        )}${notIn('userId')}
        GROUP BY event`,
        [...WEB_EVENTS, d, ...ex]
      ),
      rows(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.via')) AS via, COUNT(*) AS count FROM event_log
        WHERE event = 'invite_share' AND ${win('createTime')}${notIn(
          'userId'
        )} GROUP BY via`,
        [d, ...ex]
      ),
      rows(
        `SELECT COUNT(*) AS invited,
              SUM(status = 'rewarded') AS rewarded,
              SUM(status = 'held' AND hold_reason = 'same_ip') AS heldSameIp,
              SUM(status = 'held' AND hold_reason = 'cap') AS heldCap,
              SUM(status = 'held' AND hold_reason IS NULL) AS heldOther,
              COUNT(DISTINCT inviter_id) AS inviters,
              COALESCE(SUM(invitee_days), 0) AS inviteeDays,
              COALESCE(SUM(inviter_days), 0) AS inviterDays
         FROM referral WHERE ${win('created_at')}${notIn('inviter_id')}`,
        [d, ...ex]
      ),
      rows(
        `SELECT via, COUNT(*) AS count FROM referral WHERE ${win(
          'created_at'
        )}${notIn('inviter_id')} GROUP BY via`,
        [d, ...ex]
      ),
      rows(
        `SELECT product, COUNT(*) AS count FROM referral WHERE ${win(
          'created_at'
        )}${notIn('inviter_id')} GROUP BY product`,
        [d, ...ex]
      ),
      rows(
        `SELECT COUNT(*) AS members, COALESCE(SUM(member_bonus_days), 0) AS bonusDays
         FROM referral WHERE member_reward_at IS NOT NULL AND ${win(
           'member_reward_at'
         )}${notIn('inviter_id')}`,
        [d, ...ex]
      ),
      rows(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.reason')) AS reason, COUNT(*) AS count FROM mcp_event
        WHERE event = 'referral_signup' AND JSON_UNQUOTE(JSON_EXTRACT(props, '$.status')) = 'ignored'
          AND ${win('created_at')} GROUP BY reason`,
        [d]
      ),
      rows(
        `SELECT inviter_id, COUNT(*) AS invited, SUM(status = 'rewarded') AS rewarded,
              SUM(member_reward_at IS NOT NULL) AS members
         FROM referral WHERE ${win('created_at')}${notIn('inviter_id')}
        GROUP BY inviter_id ORDER BY invited DESC LIMIT 10`,
        [d, ...ex]
      ),
    ]);

  const ev = (name: string) => {
    if (web == null) return null;
    const r = web.find(x => x.event === name);
    return { count: n(r?.count), users: n(r?.users) };
  };
  const pts = await rows(
    `SELECT COALESCE(SUM(delta), 0) AS pts FROM mcp_points_ledger
      WHERE reason IN ('referral', 'referral_member') AND ${win(
        'created_at'
      )}${notIn('user_id')}`,
    [d, ...ex]
  );
  const s = signups?.[0];
  const p = paid?.[0];
  const toMap = (list: Record<string, any>[] | null, key: string) =>
    list == null
      ? null
      : Object.fromEntries(
          list.map(r => [String(r[key] ?? '(无)'), n(r.count)])
        );

  return {
    days: d,
    funnel: {
      cardView: ev('invite_card_view'),
      share: ev('invite_share'),
      landing: ev('invite_landing'),
      bannerView: ev('invite_banner_view'),
      bannerClick: ev('invite_banner_click'),
      invited: s ? n(s.invited) : null,
      rewarded: s ? n(s.rewarded) : null,
      paidMembers: p ? n(p.members) : null,
    },
    shareVia: toMap(shareVia, 'via'),
    invitedVia: toMap(byVia, 'via'),
    invitedProduct: toMap(byProduct, 'product'),
    held: s
      ? { sameIp: n(s.heldSameIp), cap: n(s.heldCap), other: n(s.heldOther) }
      : null,
    rejected: toMap(rejected, 'reason'),
    bind: ev('invite_bind'),
    activeInviters: s ? n(s.inviters) : null,
    cost: {
      inviteeDays: s ? n(s.inviteeDays) : null,
      inviterDays: s ? n(s.inviterDays) : null,
      paidBonusDays: p ? n(p.bonusDays) : null,
      points: pts ? n(pts[0]?.pts) : null,
    },
    topInviters:
      top == null
        ? null
        : top.map(r => ({
            inviter: maskUser(String(r.inviter_id)),
            invited: n(r.invited),
            rewarded: n(r.rewarded),
            members: n(r.members),
          })),
  };
}
