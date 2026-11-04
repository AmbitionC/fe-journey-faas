/**
 * 付费来源（owner 2026-11-04：「最近两笔付费从哪个产品渠道来的？」「把埋点加验证，方便后续分析用户画像和使用习惯」）。
 *
 * 两站下单时（POST /mcp/me/orders）前端带一个 entry 对象：
 * - 这一单是从哪个入口点进来的（最近一次站内会员入口 cta / 会员页 ?from= / 下单页面）；
 * - 这个访客第一次是从哪来的（首触外部来源域名、落地页、ch/utm、距今几天）；
 * - 设备类型、匿名访客 id（把下单前的匿名浏览串起来）。
 *
 * 这里负责清洗成扁平字段（mcp_event.props 只收一层、≤20 个键），写进 order_created，
 * 到账时再从 order_created 取回，跟着 order_paid 和收款提醒邮件一起走。
 * 字段约定改动要同步：两站 `src/utils/attribution.ts`、管理后台「漏斗与留存 › 付费来源」。
 */

export interface OrderEntry {
  /** 下单发生在哪个页面：member（Agent 会员页）/ developer（Agent Skill 页）/ invest_skills */
  entryPage?: string;
  /** 下单前最近一次点的站内入口（member_cta source / Skill 页 label） */
  entryCta?: string;
  /** 会员页 / Skill 页 URL 上的 ?from= */
  entryFrom?: string;
  /** 首触：外部来源域名（bing.com、xiaohongshu.com…），站内跳转不算 */
  ftRef?: string;
  /** 首触：落地页路径 */
  ftLanding?: string;
  /** 首触：?ch= 或 utm_source */
  ftCh?: string;
  ftMedium?: string;
  ftCampaign?: string;
  /** 首触距下单多少天 */
  ftDays?: number;
  device?: 'mobile' | 'tablet' | 'desktop';
  anonId?: string;
}

const STR_KEYS = [
  'entryPage',
  'entryCta',
  'entryFrom',
  'ftRef',
  'ftLanding',
  'ftCh',
  'ftMedium',
  'ftCampaign',
] as const;

/** 只留看得懂的字符，防止有人往库里写任意文本。 */
function cleanStr(v: any, max = 64): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .trim()
    .replace(/[^\w\-./:%@+~一-龥]/g, '')
    .slice(0, max);
  return s || undefined;
}

/** 来源域名统一成不带 www. 的 hostname；传进来的是完整 URL 也认。 */
export function refHost(v: any): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  let h = v.trim();
  try {
    if (/^https?:\/\//i.test(h)) h = new URL(h).hostname;
  } catch {
    return undefined;
  }
  h = h.toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9.-]{1,64}$/.test(h) ? h : undefined;
}

export function sanitizeEntry(raw: any): OrderEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: OrderEntry = {};
  for (const k of STR_KEYS) {
    const v = k === 'ftRef' ? refHost(raw[k]) : cleanStr(raw[k]);
    if (v) (out as any)[k] = v;
  }
  const days = Number(raw.ftDays);
  if (Number.isFinite(days) && days >= 0 && days < 3650)
    out.ftDays = Math.floor(days);
  if (['mobile', 'tablet', 'desktop'].includes(raw.device))
    out.device = raw.device;
  const anon = cleanStr(raw.anonId, 64);
  if (anon && /^a_[a-z0-9]{4,40}$/.test(anon)) out.anonId = anon;
  return Object.keys(out).length ? out : null;
}

/** 写进 mcp_event.props 的那部分（anonId 走事件表自己的 anon_id 列）。 */
export function entryProps(e: OrderEntry | null): Record<string, any> {
  if (!e) return {};
  const rest: Record<string, any> = { ...e };
  delete rest.anonId;
  return rest;
}

/** 站内入口码 → 人话（收款邮件、后台表格用）。没登记的原样显示。 */
const CTA_LABELS: [RegExp, string][] = [
  [/^reading_quota_hint_knowledge/, '知识点限看提示'],
  [/^reading_quota_hint_interview/, '面经限看提示'],
  [/^reading_quota_hint_algorithm/, '算法题限看提示'],
  [/^reading_quota_knowledge/, '知识点限看拦截'],
  [/^reading_quota_interview/, '面经限看拦截'],
  [/^reading_quota_algorithm/, '算法题限看拦截'],
  [/^reading_quota/, '限看额度提示'],
  [/^header_/, '页头「会员」按钮'],
  [/^services_member_modal/, '服务页会员权益弹窗'],
  [/^services_detail/, '服务页会员卡片（看详情）'],
  [/^services/, '服务页会员卡片'],
  [/^home/, '首页会员入口'],
  [/^profile/, '个人中心会员卡'],
  [/^interview_sheet/, '面经题单'],
  [/^interview_topics/, '高频考点榜'],
  [/^mock_interview/, '模拟面试'],
  [/^mission_guide/, '实战任务带练'],
  [/^project_gate/, '项目实战付费墙'],
  [/^developer_/, 'Skill 页价格区'],
  [/^iris/, 'Iris 额度提示'],
  [/^credit_exhausted/, 'Skill 点数用完提示'],
  [/^credit_low/, 'Skill 点数不足提醒'],
];

const PAGE_LABELS: Record<string, string> = {
  member: 'Agent Journey 会员页',
  developer: 'Agent Journey Skill 页',
  invest_skills: 'Invest Journey 数据服务页',
};

export function ctaLabel(code?: string | null): string | null {
  if (!code) return null;
  for (const [re, label] of CTA_LABELS) if (re.test(code)) return label;
  return code;
}

/** 一行人话：「知识点限看提示 → Agent Journey 会员页；首次来自 bing.com（落地 /developer，2 天前）· 电脑」 */
export function describeEntry(
  e: Partial<OrderEntry> | null | undefined
): string {
  if (!e || !Object.keys(e).length) return '未记录（下单页面没带来源）';
  const parts: string[] = [];
  const cta = ctaLabel(e.entryCta) || ctaLabel(e.entryFrom);
  const page = e.entryPage ? PAGE_LABELS[e.entryPage] || e.entryPage : null;
  parts.push([cta, page].filter(Boolean).join(' → ') || '直接打开下单页');
  const ft: string[] = [];
  if (e.ftCh) ft.push(`渠道 ${e.ftCh}`);
  if (e.ftRef) ft.push(e.ftRef);
  const ftWhere = ft.length ? `首次来自 ${ft.join(' / ')}` : '首次是直接访问';
  const ftMore = [
    e.ftLanding ? `落地 ${e.ftLanding}` : '',
    e.ftDays != null ? (e.ftDays === 0 ? '当天' : `${e.ftDays} 天前`) : '',
  ].filter(Boolean);
  parts.push(ftMore.length ? `${ftWhere}（${ftMore.join('，')}）` : ftWhere);
  const dev = { mobile: '手机', tablet: '平板', desktop: '电脑' }[
    e.device as string
  ];
  return parts.join('；') + (dev ? ` · ${dev}` : '');
}

/** 从 order_created 事件的 props 里取回 entry 字段。 */
export function entryFromProps(p: any): OrderEntry | null {
  if (!p || typeof p !== 'object') return null;
  const out: any = {};
  for (const k of [...STR_KEYS, 'ftDays', 'device'])
    if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  return Object.keys(out).length ? out : null;
}
