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
export const REFERRAL_GLOSSARY = {
  scope:
    '窗口内发生数（近 days 天），已排除内部账号；值为 null 表示该项查询失败，不是 0。前端事件游客按 guest:ip 去重。',
  'funnel.cardView': '看到个人页邀请卡的次数/人数（invite_card_view）',
  'funnel.share':
    '点了分享（复制链接 / 下载二维码 / 复制文案）的次数/人数（invite_share）',
  'funnel.landing': '好友带 ?invite= 打开站点的次数/人数（invite_landing）',
  'funnel.bannerView': '未登录访客看到「XX 邀请你」横幅（invite_banner_view）',
  'funnel.bannerClick': '点了横幅上的「注册领取」（invite_banner_click）',
  'funnel.invited': '新建立的邀请关系数（referral 表，含冻结的）',
  'funnel.rewarded': '其中发了注册奖励的',
  'funnel.paidMembers': '窗口内被邀请好友开通会员、邀请人拿到付费返利的人数',
  shareVia: '分享方式：link 链接 / qr 二维码 / text 文案',
  invitedVia:
    '建立关系的入口：signup 密码注册 / sms 短信注册 / bind 注册后补填',
  invitedProduct: '被邀请人从哪个产品来：agent / invest / kids（栗栗学英语）',
  held: '建了关系但不发注册奖励：sameIp 24 小时内同一网络重复注册（疑似刷号）/ cap 邀请人当月已满 10 人',
  rejected:
    '填了码但没建立关系的原因：unknown_code 码无效 / self 自邀 / circular 互邀 / exists 已有邀请人 / too_late 超过 7 天补填期',
  bind: '注册后补填邀请码的操作次数（含失败）',
  activeInviters: '窗口内至少带来 1 个邀请关系的邀请人数',
  cost: '窗口内发出的权益：会员天数（被邀请人 / 邀请人 / 好友付费返）与点数（1 点≈¥0.1）',
  topInviters: '邀请最多的 10 人（手机号脱敏）',
};

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
    // 给读导出的人 / AI 的字段说明：复盘时直接据此解读，不用回头翻代码
    glossary: REFERRAL_GLOSSARY,
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
