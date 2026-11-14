import { randomBytes } from 'crypto';
import { QueryFn, Product } from './store';
import { SITES, rechargeLink } from './sites';

/**
 * Journey 点计费：账户余额、会员档位、按次扣点、订单。
 *
 * 定价参照可灵（月卡/年卡 + 点数 + 加油包）。SKU 只写原价 listCents，实际售价由收费阶段决定
 * （见 PRICING_PHASES）：2026-11-01 起送体验点、用完充值，早期用户半价（页面展示原价）→ 正式价。
 *
 * 规则（刻意从简）：
 * - 1 点 ≈ ¥0.1 的计价单位，Agent / Invest 两个产品共用一个余额。
 * - 会员按月发点：开通时立刻发第一个月，之后每满一个月懒发放（用户下次调用/打开后台时补发），
 *   年卡同理按月发 12 次。点数不过期（实验阶段从宽）。
 * - 加油包一次性加点，与会员无关。
 * - 新用户首次开通送少量体验点（TRIAL_POINTS），用完必须充值（会员或加油包）——
 *   owner 2026-11-01：不能完全免费，否则验证不了商业价值。
 * - 所有时间比较都在 SQL 里用 NOW() 做，避免 FC 实例时区与库时区不一致。
 */

/**
 * 档位只有「体验」和「会员」两档（owner 2026-10-31：产品能力还没到能分级的程度，不分入门 / Pro）。
 * 会员原价 ¥29/月（owner 定，卖点「一天不到一块钱」），年卡 ¥239。
 * 'starter' / 'pro' 是 2026-10-30 版的旧档位名，库里若有存量账户按会员处理（effectiveTier）。
 */
export type Tier = 'free' | 'member';
type StoredTier = Tier | 'starter' | 'pro';

export interface TierSpec {
  name: string;
  maxKeys: number;
  dailyLimit: number;
}

export const TIERS: Record<Tier, TierSpec> = {
  free: { name: '体验', maxKeys: 1, dailyLimit: 200 },
  member: { name: '会员', maxKeys: 2, dailyLimit: 1500 },
};

/** 会员每月发放点数（2026-11-04 owner：额度加倍，400 → 800） */
export const MEMBER_MONTHLY_POINTS = 800;

/**
 * 新用户开通赠送的体验点（owner 2026-11-01 改：取消「公测免费不扣点」，改为送少量点、用完充值）。
 * 2026-11-04 owner：额度加倍，50 → 100（strategy-builder 这类多步场景一次要十几次调用，50 点跑不完一轮）。
 * 100 点约够跑通 10 次以上核心场景（一次「搜知识点 + 读两篇 + 查面经」≈ 8 点，
 * 一次 Invest 完整回测「行情快照 + 恐慌 + 乖离率 + 宏观」≈ 30 点（2026-11-04 Invest 单价上调后）。
 * 同日起 TRIAL_DAYS 天到期清零（见下）。
 */
export const TRIAL_POINTS = 100;

/**
 * 体验点有效期（2026-11-04 owner 拍板「方案 A」）：开通起 TRIAL_DAYS 天内有效，到期没用完的体验点清零。
 * 动机：体验点不过期 + Invest 单价低时，每天看盘的人 100 点能用一个半月、每周看一次的能用半年＝长期白用。
 * 目标是「14 天内够跑一次完整回测 + 每天看一眼市场」，之后要用就开会员或买加油包。
 * 只清体验点（mcp_account.trial_points）：买的点、会员月度点、邀请人奖励不受影响。扣点时先扣体验点。
 */
export const TRIAL_DAYS = 14;

/**
 * @deprecated 充值页按产品取：`siteOf(product).recharge`（./sites.ts）。
 * 这里只保留 Agent Journey 的那一条给没有产品上下文的老调用方。
 */
export const RECHARGE_URL = SITES.agent.recharge;

export interface Sku {
  sku: string;
  name: string;
  kind: 'plan' | 'pack';
  /** 原价（分）。实际售价按收费阶段算，见 phasePrice() */
  listCents: number;
  tier?: Tier;
  months?: number;
  /** plan：每月发放点数；pack：一次性点数 */
  points: number;
  desc: string;
  /**
   * 只在这些产品的价目里出现；不写＝所有产品都卖。
   * 会员档位本身各产品通用，这里只管「哪个站把它摆出来卖」。
   */
  products?: Product[];
}

export const SKUS: Sku[] = [
  {
    sku: 'member_month',
    name: '会员月卡',
    kind: 'plan',
    tier: 'member',
    months: 1,
    points: MEMBER_MONTHLY_POINTS,
    listCents: 2900,
    desc: `一天不到一块钱 · 每月 ${MEMBER_MONTHLY_POINTS} 点 · ${TIERS.member.maxKeys} 个 Key · 每日 ${TIERS.member.dailyLimit} 次`,
  },
  {
    sku: 'member_year',
    name: '会员年卡',
    kind: 'plan',
    tier: 'member',
    months: 12,
    points: MEMBER_MONTHLY_POINTS,
    listCents: 23900,
    desc: `每月 ${MEMBER_MONTHLY_POINTS} 点 × 12 个月 · 约 7 折`,
  },
  {
    // owner 2026-11-13：Agent Journey 加 ¥49 通行证、月卡保留，「相当于之前的年卡」——
    // 年卡半价 ¥119.5 超过支付宝单笔 ¥50 一直买不了，这一档半价 ¥49 正好在限额内。
    // 求职 / 备考是一次性周期，一次买半年比按月续更贴合。只在 Agent Journey 卖。
    sku: 'member_pass',
    name: '半年通行证',
    kind: 'plan',
    tier: 'member',
    months: 6,
    points: MEMBER_MONTHLY_POINTS,
    listCents: 9800,
    desc: `一次买 6 个月，覆盖一整个求职 / 备考季 · 每月 ${MEMBER_MONTHLY_POINTS} 点`,
    products: ['agent'],
  },
  {
    sku: 'pack_100',
    name: '加油包 100 点',
    kind: 'pack',
    points: 100,
    listCents: 1000,
    desc: '一次性 100 点，不过期',
  },
  {
    sku: 'pack_500',
    name: '加油包 500 点',
    kind: 'pack',
    points: 500,
    listCents: 4500,
    desc: '一次性 500 点，不过期',
  },
  {
    sku: 'pack_1100',
    name: '加油包 1100 点',
    kind: 'pack',
    points: 1100,
    listCents: 8800,
    desc: '一次性 1100 点，不过期',
  },
];

export type PhaseId = 'free' | 'half' | 'full';

export interface PricingPhase {
  id: PhaseId;
  name: string;
  /** 北京时间 YYYY-MM-DD 零点起生效；null＝日期待定（还没到这一阶段） */
  from: string | null;
  note: string;
}

/**
 * 收费阶段（owner 2026-10-31 定三阶段，2026-11-01 改）：
 * 1. 公测免费（2026-10-31 一天）：调用不扣点、不开放购买。2026-11-01 owner 改主意——完全免费验证不了
 *    商业价值，改为新用户送 TRIAL_POINTS 体验点、用完必须充值，免费阶段就此结束（条目保留作历史）；
 * 2. 半价：原价五折，页面同时展示原价。原计划 12-01 起，随免费期取消提前到 11-01；
 * 3. 正式价：按原价。日期等数据出来后由 owner 定，填进 from 即可。
 */
export const PRICING_PHASES: PricingPhase[] = [
  {
    id: 'free',
    name: '公测免费',
    from: '2026-10-31',
    note: '公测首月免费：所有工具调用不扣点，无需购买。',
  },
  {
    id: 'half',
    name: '早期用户半价',
    from: '2026-11-01',
    note: `新用户开通即送 ${TRIAL_POINTS} 点体验额度（${TRIAL_DAYS} 天内有效），用完或到期后开通会员或购买加油包继续使用；早期用户半价，已购会员在有效期内不受后续调价影响。`,
  },
  {
    id: 'full',
    name: '正式价',
    from: null,
    note: '按原价收费。',
  },
];

/** 北京时间 YYYY-MM-DD 零点对应的时刻。 */
function bjMidnight(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00+08:00`);
}

/** 当前生效的阶段，以及下一阶段（日期已定的话）。 */
export function currentPhase(now = new Date()) {
  const t = now.getTime();
  let idx = 0;
  PRICING_PHASES.forEach((p, i) => {
    if (p.from && bjMidnight(p.from) <= t) idx = i;
  });
  const phase = PRICING_PHASES[idx];
  const next = PRICING_PHASES[idx + 1];
  return {
    ...phase,
    next:
      next && next.from
        ? { id: next.id, name: next.name, from: next.from }
        : null,
  };
}

/** 某产品站点摆出来卖的商品：没限定产品的都卖，限定了的只在自己的站卖（不传产品＝不摆）。 */
export function skusFor(product?: Product | null): Sku[] {
  return SKUS.filter(
    s => !s.products || (!!product && s.products.includes(product))
  );
}

/** 某阶段下的售价（分）。 */
export function phasePrice(
  sku: Pick<Sku, 'listCents'>,
  phase: PhaseId
): number {
  if (phase === 'free') return 0;
  if (phase === 'half') return Math.round(sku.listCents / 2);
  return sku.listCents;
}

/**
 * 旧版（入门 / Pro）商品：不再出售，只用于给改版前下的订单发货——
 * 按下单时的点数发放，档位记为会员。
 */
const LEGACY_SKUS: Sku[] = [
  ['starter_month', '入门月卡', 1, 300, 2900],
  ['starter_year', '入门年卡', 12, 300, 19900],
  ['pro_month', 'Pro 月卡', 1, 1200, 7900],
  ['pro_year', 'Pro 年卡', 12, 1200, 59900],
].map(([sku, name, months, points, listCents]) => ({
  sku: sku as string,
  name: name as string,
  kind: 'plan' as const,
  tier: 'member' as const,
  months: months as number,
  points: points as number,
  listCents: listCents as number,
  desc: '已下架',
}));

/**
 * 支付宝收款测试单：仅管理员可下（免费期也能下），¥0.01，不发点、不计入营收统计。
 * 用于正式收费前真实走一遍收银台 → 异步通知 → 发货。
 */
export const PAY_TEST_SKU: Sku = {
  sku: 'pay_test',
  name: '支付宝收款测试',
  kind: 'pack',
  points: 0,
  listCents: 1,
  desc: '仅管理员可下，用于验证支付宝收款，不发点',
};

/**
 * 点数用完时给 Agent 看的报错文案：说清还差多少、去哪充、最便宜的两个选项多少钱（按当前阶段价）。
 * Agent 会把这段原样转述给用户，所以要人话、带链接、不带内部字段名。
 */
export function creditExhaustedMessage(
  cost: number,
  balance: number,
  now = new Date(),
  product: Product = 'agent'
): string {
  const phase = currentPhase(now);
  const yuan = (c: number) =>
    `¥${(c / 100).toFixed(c % 100 ? (c % 10 ? 2 : 1) : 0)}`;
  const opt = (id: string, label: (s: Sku, p: string) => string) => {
    const s = SKUS.find(x => x.sku === id);
    if (!s) return '';
    const p = phasePrice(s, phase.id);
    const was = p < s.listCents ? `（原价 ${yuan(s.listCents)}）` : '';
    return label(s, yuan(p) + was);
  };
  const options = [
    opt('member_month', (s, p) => `会员月卡 ${p}，每月 ${s.points} 点`),
    opt('pack_100', (s, p) => `加油包 ${s.points} 点 ${p}`),
  ]
    .filter(Boolean)
    .join('；');
  return (
    `Journey 点数不足：本次调用需要 ${cost} 点，账户剩余 ${balance} 点（体验额度已用完或已到期）。` +
    `请到 ${rechargeLink('credit_exhausted', product)} 充值后继续使用：${options}。` +
    '充值到账后直接重试即可，Key 不用换。'
  );
}

/** 在售商品（下单只认这些） */
export function findSellableSku(sku: string): Sku | undefined {
  return SKUS.find(s => s.sku === sku);
}

/** 含已下架商品（发货、展示历史订单用） */
export function findSku(sku: string): Sku | undefined {
  if (sku === PAY_TEST_SKU.sku) return PAY_TEST_SKU;
  return SKUS.find(s => s.sku === sku) || LEGACY_SKUS.find(s => s.sku === sku);
}

/**
 * Iris（网站内的 AI 面试教练）各模式扣点（owner 2026-11-02：「Iris 的调用也应该算到 credit」）。
 * 键即点数流水的 ref（`iris_<mode>`），与 Skill 工具并列进经营看板的 topTools。
 * - chat：普通问答 / 考一考 / 划线问 / 算法提示与点评 / 简答判分（DeepSeek V4.1 Flash 非思考）
 * - think：深度思考问答（思考链约再花 2000 tokens，成本翻倍）
 * - interview：模拟面试每一轮（会员专享）
 * - report：模拟面试复盘报告（2026-11-07 起同为 V4.1 Flash，会员专享）
 * 成本参照（高峰价）：一次问答约 ¥0.016–0.02，1 点名义 ¥0.1、会员实付 ¥0.036–0.0725。
 */
export type IrisMode = 'chat' | 'think' | 'interview' | 'report';
export const IRIS_COST: Record<IrisMode, number> = {
  chat: 1,
  think: 2,
  interview: 1,
  report: 5,
};
/** 登录用户每天免费的普通问答次数（不扣点，只覆盖 chat 模式） */
export const IRIS_FREE_DAILY = 3;
/** 游客（按 IP）每天的普通问答次数；游客不能开深度思考、不进点数账户 */
export const IRIS_GUEST_DAILY = 3;
/** 每账户每天 Iris 调用上限（成本保险丝，防脚本刷点） */
export const IRIS_DAILY_CAP: Record<Tier, number> = { free: 60, member: 300 };
/** 只对会员开放的模式：点数是用量、会员是资格 */
export const IRIS_MEMBER_ONLY: IrisMode[] = ['interview', 'report'];

export function irisCost(mode: IrisMode): number {
  return IRIS_COST[mode] ?? 1;
}

/** 点数流水里 Iris 的 ref（与 Skill 工具名同一列） */
export function irisLedgerRef(mode: IrisMode): string {
  return `iris_${mode}`;
}

/** 给前端的 Iris 计费说明（/mcp/pricing 的 iris 块；前端文案全部从这里读，不写死） */
export function irisPricing() {
  return {
    costs: { ...IRIS_COST },
    freeDaily: IRIS_FREE_DAILY,
    guestDaily: IRIS_GUEST_DAILY,
    memberOnly: [...IRIS_MEMBER_ONLY],
    dailyCap: { ...IRIS_DAILY_CAP },
    note: `登录用户每天前 ${IRIS_FREE_DAILY} 次问答免费；之后问答 ${IRIS_COST.chat} 点、深度思考 ${IRIS_COST.think} 点、模拟面试每轮 ${IRIS_COST.interview} 点、复盘报告 ${IRIS_COST.report} 点。模拟面试与复盘报告为会员专享。`,
  };
}

/**
 * 邀请奖励（分享拉新，owner 2026-11-02）。货币是点数不是会员时长：成本可控，且与 Iris 直接挂钩。
 * - invitee：被邀请人带码注册，在体验点之外另得
 * - inviter：邀请人在被邀请人注册成功时得
 * - memberBonus：被邀请人首次开通会员（月卡/年卡到账）时邀请人再得
 * - monthlyCap：邀请人每月最多计奖的注册人数（开会员返点不设上限，有真实收入对应）
 */
export const REFERRAL_REWARD = {
  invitee: 30,
  inviter: 30,
  memberBonus: 100,
  monthlyCap: 10,
};

/**
 * 邀请换来的会员天数（2026-11-05 owner：做「分享码 → 好友注册 → 双方加体验天数」的社群裂变，
 * 但**权益别给太多**——校招用户本来就只用一段时间，白拿的天数多了就不转付费了）。
 * 所以注册奖励只给 3 天，邀请人靠拉新拿的天数每月 / 终身都封顶；好友真付费开会员才大方一点（不计上限）。
 * 天数写 member_entitlement（source=referral），网站会员权益随之放行；不动 Skill 会员档位与月度点数。
 */
export const REFERRAL_DAYS = {
  invitee: 3,
  inviter: 3,
  memberBonus: 7,
  /** 邀请人靠「好友注册」拿到的天数：每自然月上限 / 终身上限（付费返的天数不计） */
  monthlyCapDays: 15,
  lifetimeCapDays: 30,
};

export function referralPricing() {
  return {
    ...REFERRAL_REWARD,
    inviteeDays: REFERRAL_DAYS.invitee,
    inviterDays: REFERRAL_DAYS.inviter,
    memberBonusDays: REFERRAL_DAYS.memberBonus,
    monthlyCapDays: REFERRAL_DAYS.monthlyCapDays,
    lifetimeCapDays: REFERRAL_DAYS.lifetimeCapDays,
    note:
      `好友通过你的邀请链接注册，双方各得 ${REFERRAL_DAYS.inviter} 天会员 + ${REFERRAL_REWARD.inviter} 点（点数与体验点一样 ${TRIAL_DAYS} 天内有效，会员获得的不过期）；` +
      `好友开通会员后你再得 ${REFERRAL_DAYS.memberBonus} 天会员 + ${REFERRAL_REWARD.memberBonus} 点。` +
      `每月最多 ${REFERRAL_REWARD.monthlyCap} 位好友计奖，邀请注册换来的会员天数每月最多 ${REFERRAL_DAYS.monthlyCapDays} 天、累计最多 ${REFERRAL_DAYS.lifetimeCapDays} 天。`,
  };
}

/** 每次调用扣多少点。未列出的工具默认 1 点；口径/清单/用量查询免费。 */
export const TOOL_COST: Record<string, number> = {
  knowledge_tree: 1,
  knowledge_search: 1,
  knowledge_get: 2,
  interview_search: 1,
  interview_get: 2,
  interview_topics: 3,
  mission_list: 1,
  mission_get: 1,
  quiz_get: 1,
  // Invest 单价 2026-11-04 owner 拍板上调（2/2/2/1 → 5/10/10/5）：一次完整回测 ≈30 点、
  // 看一眼市场 5 点，14 天体验期正好够 1 次回测 + 每天看一眼；会员重度用法 ≈370 点/月 < 800。
  market_snapshot: 5,
  fear_series: 10,
  bias_series: 10,
  macro_series: 5,
  // 第二批（2026-11-05）：情绪/板块排行与快照同价；历史序列类当天只扣一次；回测成绩免费（拉新用）
  market_sentiment: 5,
  sector_rank: 5,
  sector_history: 5,
  index_history: 5,
  // 2026-11-14 常见指数统一指标：最新一览 / 单指数序列，同指数日线价、当天只扣一次
  index_metrics: 5,
  rule_backtest: 0,
  indicator_list: 0,
  methodology_get: 0,
  account_usage: 0,
};

/**
 * 历史序列类工具「当天只扣一次」（2026-11-04 owner 反馈 strategy-builder 一次没跑完点数就没了）：
 * 实测一位体验用户在 7 秒里按年分段拉了 25 次 fear_series（全历史一次返回太大，Agent 只能分段取），
 * 每次 2 点、50 点体验额度全部耗在取同一份数据上，回测还没开始就点数不足。
 * 同一账户同一工具在同一自然日（库时区＝北京时间）已成功扣过点，再调不扣——按「取一份数据」收费，
 * 不按 Agent 分几段取收费。失败退点后不算已付（下一次照常扣）。
 */
export const DAY_PASS_TOOLS = [
  'fear_series',
  'bias_series',
  'macro_series',
  'market_sentiment',
  'sector_history',
  'index_history',
  'index_metrics',
];

export function isDayPassTool(tool: string): boolean {
  return DAY_PASS_TOOLS.includes(tool);
}

export function toolCost(tool: string): number {
  return TOOL_COST[tool] ?? 1;
}

/**
 * 每个产品对外的工具名（与 tools/agent.ts、tools/invest.ts 的 tools 一一对应，单测钉住不漂）。
 * /mcp/pricing?product= 据此只下发该产品的价目：两个站各自只讲自己的工具。
 */
export const PRODUCT_TOOLS: Record<Product, string[]> = {
  agent: [
    'knowledge_tree',
    'knowledge_search',
    'knowledge_get',
    'interview_search',
    'interview_get',
    'interview_topics',
    'mission_list',
    'mission_get',
    'quiz_get',
    'account_usage',
  ],
  invest: [
    'market_snapshot',
    'fear_series',
    'bias_series',
    'macro_series',
    'market_sentiment',
    'sector_rank',
    'sector_history',
    'index_history',
    'index_metrics',
    'rule_backtest',
    'indicator_list',
    'methodology_get',
    'account_usage',
  ],
};

/** 某产品的价目（工具 → 点数）；不传产品返回全部。 */
export function toolCostFor(product?: Product | null): Record<string, number> {
  if (!product) return TOOL_COST;
  const out: Record<string, number> = {};
  for (const t of PRODUCT_TOOLS[product]) out[t] = toolCost(t);
  return out;
}

export interface Account {
  user_id: string;
  points: number;
  tier: StoredTier;
  /** 档位是否在有效期内（过期即按 free 处理，余额照常可用） */
  active: boolean;
  tier_expire_at: string | null;
  next_grant_at: string | null;
  monthly_points: number;
  /** 余额里还没用掉的体验点（到期清零的那部分） */
  trial_points: number;
  /** 体验点到期时间；null＝没有体验点 */
  trial_expire_at: string | null;
}

export function effectiveTier(
  a: Pick<Account, 'tier' | 'active'> | null
): Tier {
  if (!a || !a.active) return 'free';
  return ['member', 'starter', 'pro'].includes(a.tier) ? 'member' : 'free';
}

export function genOrderNo(now = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
  return `MJ${d}${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** 收款时让用户在转账备注里写的短码（订单号后 6 位），方便人工对账。 */
export function payCode(orderNo: string): string {
  return orderNo.slice(-6);
}

export class BillingStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private q: QueryFn) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_account (
          user_id VARCHAR(64) NOT NULL PRIMARY KEY,
          points INT NOT NULL DEFAULT 0,
          tier VARCHAR(16) NOT NULL DEFAULT 'free',
          tier_expire_at DATETIME NULL,
          next_grant_at DATETIME NULL,
          monthly_points INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) DEFAULT CHARSET=utf8mb4`);
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_points_ledger (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          delta INT NOT NULL,
          reason VARCHAR(16) NOT NULL,
          ref VARCHAR(64) NULL,
          note VARCHAR(255) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_mcp_ledger_user (user_id, created_at),
          KEY idx_mcp_ledger_time (created_at)
        ) DEFAULT CHARSET=utf8mb4`);
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_order (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_no VARCHAR(32) NOT NULL,
          user_id VARCHAR(64) NOT NULL,
          sku VARCHAR(32) NOT NULL,
          amount_cents INT NOT NULL,
          list_cents INT NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          reported_at DATETIME NULL,
          paid_at DATETIME NULL,
          handled_by VARCHAR(128) NULL,
          note VARCHAR(255) NULL,
          UNIQUE KEY uk_mcp_order_no (order_no),
          KEY idx_mcp_order_user (user_id, created_at),
          KEY idx_mcp_order_status (status, created_at)
        ) DEFAULT CHARSET=utf8mb4`);
        // 体验点有效期（2026-11-04）：线上表已建，补列。MySQL 8 没有 ADD COLUMN IF NOT EXISTS，先查再补。
        const cols = await this.q(
          "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mcp_account'"
        );
        const names = new Set(
          (cols || []).map((c: any) => String(c.COLUMN_NAME || c.column_name))
        );
        if (!names.has('trial_points')) {
          await this.q(
            'ALTER TABLE mcp_account ADD COLUMN trial_points INT NOT NULL DEFAULT 0, ADD COLUMN trial_expire_at DATETIME NULL'
          );
          // 存量账户：从没买过点、没当过会员、没被管理员加过点的，余额全部来自体验/补发，
          // 记为体验点，从今天起算 TRIAL_DAYS 天（不追溯开通日）。
          await this.q(
            `UPDATE mcp_account SET trial_points = points, trial_expire_at = DATE_ADD(NOW(), INTERVAL ${TRIAL_DAYS} DAY) ` +
              'WHERE points > 0 AND tier_expire_at IS NULL AND user_id NOT IN (' +
              "SELECT user_id FROM mcp_points_ledger WHERE reason IN ('pack', 'plan_grant', 'admin'))"
          );
        }
      })().catch(e => {
        this.schemaReady = null;
        throw e;
      });
    }
    return this.schemaReady;
  }

  private async ledger(
    userId: string,
    delta: number,
    reason: string,
    ref?: string,
    note?: string
  ) {
    await this.q(
      'INSERT INTO mcp_points_ledger (user_id, delta, reason, ref, note) VALUES (?, ?, ?, ?, ?)',
      [
        userId,
        delta,
        reason,
        ref ? ref.slice(0, 64) : null,
        note ? note.slice(0, 255) : null,
      ]
    );
  }

  private async read(userId: string): Promise<Account | null> {
    const rows = await this.q(
      'SELECT user_id, points, tier, tier_expire_at, next_grant_at, monthly_points, trial_points, trial_expire_at, ' +
        '(tier_expire_at IS NOT NULL AND tier_expire_at > NOW()) AS active ' +
        'FROM mcp_account WHERE user_id = ?',
      [userId]
    );
    const r = rows?.[0];
    if (!r) return null;
    return {
      user_id: r.user_id,
      points: Number(r.points),
      tier: r.tier,
      active: Number(r.active) === 1,
      tier_expire_at: r.tier_expire_at ? String(r.tier_expire_at) : null,
      next_grant_at: r.next_grant_at ? String(r.next_grant_at) : null,
      monthly_points: Number(r.monthly_points || 0),
      trial_points: Number(r.trial_points || 0),
      trial_expire_at:
        Number(r.trial_points || 0) > 0 && r.trial_expire_at
          ? String(r.trial_expire_at)
          : null,
    };
  }

  /** 体验点到期清零（懒执行：读账户、扣点前各做一次）。只清体验点那部分，入流水 trial_expire。 */
  private async expireTrial(userId: string) {
    const rows = await this.q(
      'SELECT trial_points FROM mcp_account WHERE user_id = ? AND trial_points > 0 ' +
        'AND trial_expire_at IS NOT NULL AND trial_expire_at <= NOW()',
      [userId]
    );
    const left = Number(rows?.[0]?.trial_points || 0);
    if (left <= 0) return;
    // SET 自左向右求值：points 先按原 trial_points 扣，再把 trial_points 清零；
    // WHERE 带上读到的值，并发时只有一个请求清得动
    const r = await this.q(
      'UPDATE mcp_account SET points = points - LEAST(points, trial_points), trial_points = 0 ' +
        'WHERE user_id = ? AND trial_points = ? AND trial_expire_at <= NOW()',
      [userId, left]
    );
    if (Number(r?.affectedRows ?? 0) > 0)
      await this.ledger(
        userId,
        -left,
        'trial_expire',
        undefined,
        `体验点 ${TRIAL_DAYS} 天到期清零`
      );
  }

  /** 懒发放会员月度点数：每满一个月补一次，直到追平或到期（最多补 24 次）。 */
  private async catchUpGrants(userId: string) {
    for (let i = 0; i < 24; i++) {
      const r = await this.q(
        'UPDATE mcp_account SET points = points + monthly_points, ' +
          'next_grant_at = DATE_ADD(next_grant_at, INTERVAL 1 MONTH) ' +
          'WHERE user_id = ? AND monthly_points > 0 AND next_grant_at IS NOT NULL ' +
          'AND next_grant_at <= NOW() AND tier_expire_at IS NOT NULL AND next_grant_at < tier_expire_at',
        [userId]
      );
      if (Number(r?.affectedRows ?? 0) === 0) return;
      const a = await this.read(userId);
      await this.ledger(
        userId,
        a?.monthly_points || 0,
        'plan_grant',
        undefined,
        '会员月度发放'
      );
    }
  }

  /** 取账户（含懒发放）；不存在返回 null。 */
  async getAccount(userId: string): Promise<Account | null> {
    await this.ensureSchema();
    await this.expireTrial(userId);
    await this.catchUpGrants(userId);
    return this.read(userId);
  }

  /** 开通（幂等）：首次创建账户并送体验点。返回 { account, created }。 */
  async activate(userId: string) {
    await this.ensureSchema();
    const r = await this.q(
      'INSERT IGNORE INTO mcp_account (user_id, points, trial_points, trial_expire_at) ' +
        `VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${TRIAL_DAYS} DAY))`,
      [userId, TRIAL_POINTS, TRIAL_POINTS]
    );
    const created = Number(r?.affectedRows ?? 0) > 0;
    if (created)
      await this.ledger(
        userId,
        TRIAL_POINTS,
        'trial',
        undefined,
        `新用户体验点（${TRIAL_DAYS} 天内有效）`
      );
    return { account: await this.getAccount(userId), created };
  }

  /**
   * 扣点（原子：余额不足不扣）。余额不足时先补发会员月度点再试一次。
   * @returns 扣后余额；余额不足返回 null。
   */
  async charge(
    userId: string,
    cost: number,
    tool: string
  ): Promise<number | null> {
    if (cost <= 0) return (await this.read(userId))?.points ?? 0;
    await this.ensureSchema();
    await this.expireTrial(userId);
    // 先扣体验点：trial_points 跟着减（不低于 0），剩下的才动买来的点
    const tryOnce = async () =>
      Number(
        (
          await this.q(
            'UPDATE mcp_account SET points = points - ?, trial_points = GREATEST(trial_points - ?, 0) ' +
              'WHERE user_id = ? AND points >= ?',
            [cost, cost, userId, cost]
          )
        )?.affectedRows ?? 0
      ) > 0;
    let ok = await tryOnce();
    if (!ok) {
      await this.catchUpGrants(userId);
      ok = await tryOnce();
    }
    if (!ok) return null;
    await this.ledger(userId, -cost, 'call', tool);
    return (await this.read(userId))?.points ?? 0;
  }

  /** 工具执行失败时退回已扣点数。 */
  /** 该工具今天（库时区自然日）是否已净扣过点：扣点次数 > 退点次数。 */
  async paidToday(userId: string, tool: string): Promise<boolean> {
    await this.ensureSchema();
    const rows = await this.q(
      "SELECT SUM(CASE WHEN reason = 'call' THEN 1 WHEN reason = 'refund' THEN -1 ELSE 0 END) n " +
        "FROM mcp_points_ledger WHERE user_id = ? AND ref = ? AND reason IN ('call', 'refund') AND created_at >= CURDATE()",
      [userId, tool]
    );
    return Number(rows?.[0]?.n || 0) > 0;
  }

  async refund(userId: string, cost: number, tool: string) {
    if (cost <= 0) return;
    // 体验期内退回体验桶（扣点时先扣的就是体验点），过期后退成普通点（量极小，不追究）
    await this.q(
      'UPDATE mcp_account SET points = points + ?, ' +
        'trial_points = IF(trial_expire_at IS NOT NULL AND trial_expire_at > NOW(), LEAST(trial_points + ?, points), trial_points) ' +
        'WHERE user_id = ?',
      [cost, cost, userId]
    );
    await this.ledger(userId, cost, 'refund', tool, '调用失败退点');
  }

  async addPoints(
    userId: string,
    points: number,
    reason: string,
    ref?: string,
    note?: string
  ) {
    await this.ensureSchema();
    await this.q(
      'INSERT IGNORE INTO mcp_account (user_id, points) VALUES (?, 0)',
      [userId]
    );
    await this.q(
      'UPDATE mcp_account SET points = points + ? WHERE user_id = ?',
      [points, userId]
    );
    await this.ledger(userId, points, reason, ref, note);
  }

  /**
   * 加一笔体验性质的点（如被邀请人注册奖励）：并入体验桶，与体验点同一到期时间；
   * 账户没有未到期体验期时从现在起算 TRIAL_DAYS 天。
   */
  async addTrialPoints(
    userId: string,
    points: number,
    reason: string,
    ref?: string,
    note?: string
  ) {
    await this.ensureSchema();
    await this.q(
      'INSERT IGNORE INTO mcp_account (user_id, points) VALUES (?, 0)',
      [userId]
    );
    await this.expireTrial(userId);
    await this.q(
      'UPDATE mcp_account SET points = points + ?, trial_points = trial_points + ?, ' +
        'trial_expire_at = IF(trial_expire_at IS NOT NULL AND trial_expire_at > NOW(), trial_expire_at, ' +
        `DATE_ADD(NOW(), INTERVAL ${TRIAL_DAYS} DAY)) WHERE user_id = ?`,
      [points, points, userId]
    );
    await this.ledger(userId, points, reason, ref, note);
  }

  /**
   * 开通/续费会员。会员未过期 → 顺延到期日（月度点照常按月发）；
   * 否则（新开、过期）→ 从现在起算，立刻发第一个月的点。
   */
  async applyPlan(userId: string, sku: Sku, ref: string) {
    await this.ensureSchema();
    await this.q(
      'INSERT IGNORE INTO mcp_account (user_id, points) VALUES (?, 0)',
      [userId]
    );
    const a = await this.getAccount(userId);
    const months = sku.months || 1;
    if (a && effectiveTier(a) === sku.tier) {
      await this.q(
        'UPDATE mcp_account SET tier_expire_at = DATE_ADD(tier_expire_at, INTERVAL ? MONTH), monthly_points = ? WHERE user_id = ?',
        [months, sku.points, userId]
      );
      await this.ledger(
        userId,
        0,
        'plan_extend',
        ref,
        `${sku.name} 顺延 ${months} 个月`
      );
      return;
    }
    await this.q(
      'UPDATE mcp_account SET tier = ?, tier_expire_at = DATE_ADD(NOW(), INTERVAL ? MONTH), ' +
        'next_grant_at = DATE_ADD(NOW(), INTERVAL 1 MONTH), monthly_points = ?, points = points + ? WHERE user_id = ?',
      [sku.tier, months, sku.points, sku.points, userId]
    );
    await this.ledger(
      userId,
      sku.points,
      'plan_grant',
      ref,
      `${sku.name} 开通，发放首月点数`
    );
  }

  async ledgerOf(userId: string, limit = 30) {
    await this.ensureSchema();
    return this.q(
      'SELECT delta, reason, ref, note, created_at FROM mcp_points_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, Math.max(1, Math.min(200, limit))]
    );
  }

  // ───────── 订单 ─────────

  /** amountCents 由调用方按当前阶段算好传入（phasePrice），订单落库的就是应付金额。 */
  async createOrder(userId: string, sku: Sku, amountCents: number) {
    await this.ensureSchema();
    // 同一用户同一商品已有未完成订单就复用，避免重复点出一堆待付款
    const open = await this.q(
      // 金额也要一致：跨阶段调价后不复用旧价格的待付款单
      "SELECT order_no, sku, amount_cents, status, created_at FROM mcp_order WHERE user_id = ? AND sku = ? AND amount_cents = ? AND status IN ('pending','self_reported') ORDER BY id DESC LIMIT 1",
      [userId, sku.sku, amountCents]
    );
    if (open?.[0]) return { ...open[0], reused: true };
    const orderNo = genOrderNo();
    await this.q(
      'INSERT INTO mcp_order (order_no, user_id, sku, amount_cents, list_cents) VALUES (?, ?, ?, ?, ?)',
      [orderNo, userId, sku.sku, amountCents, sku.listCents]
    );
    return {
      order_no: orderNo,
      sku: sku.sku,
      amount_cents: amountCents,
      status: 'pending',
      // 与复用分支（SELECT 回来的 created_at）对齐，前端订单弹框据此显示下单时间
      created_at: new Date(),
      reused: false,
    };
  }

  async getOrder(orderNo: string) {
    await this.ensureSchema();
    const rows = await this.q('SELECT * FROM mcp_order WHERE order_no = ?', [
      orderNo,
    ]);
    return rows?.[0] || null;
  }

  async ordersOf(userId: string) {
    await this.ensureSchema();
    return this.q(
      'SELECT order_no, sku, amount_cents, list_cents, status, created_at, reported_at, paid_at FROM mcp_order WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      [userId]
    );
  }

  /** 用户点「我已支付」：pending → self_reported（只能改自己的单）。 */
  async reportPaid(orderNo: string, userId: string): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.q(
      "UPDATE mcp_order SET status = 'self_reported', reported_at = NOW() WHERE order_no = ? AND user_id = ? AND status = 'pending'",
      [orderNo, userId]
    );
    return Number(r?.affectedRows ?? 0) > 0;
  }

  /**
   * 确认到账并发货（幂等：只有 pending/self_reported 能转 paid，重复确认不会重复发点）。
   * @returns 'ok' | 'not_found' | 'already'
   */
  async fulfill(
    orderNo: string,
    actor: string
  ): Promise<'ok' | 'not_found' | 'already'> {
    await this.ensureSchema();
    const o = await this.getOrder(orderNo);
    if (!o) return 'not_found';
    const r = await this.q(
      "UPDATE mcp_order SET status = 'paid', paid_at = NOW(), handled_by = ? WHERE order_no = ? AND status IN ('pending','self_reported')",
      [actor.slice(0, 128), orderNo]
    );
    if (Number(r?.affectedRows ?? 0) === 0) return 'already';
    const sku = findSku(o.sku);
    if (!sku) return 'ok';
    if (sku.kind === 'plan') await this.applyPlan(o.user_id, sku, orderNo);
    else if (sku.points > 0)
      await this.addPoints(o.user_id, sku.points, 'pack', orderNo, sku.name);
    return 'ok';
  }

  async reject(
    orderNo: string,
    actor: string,
    note?: string
  ): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.q(
      "UPDATE mcp_order SET status = 'rejected', handled_by = ?, note = ? WHERE order_no = ? AND status IN ('pending','self_reported')",
      [actor.slice(0, 128), (note || '').slice(0, 255) || null, orderNo]
    );
    return Number(r?.affectedRows ?? 0) > 0;
  }

  async listOrders(status?: string, limit = 100) {
    await this.ensureSchema();
    const w = status ? 'WHERE status = ?' : '';
    return this.q(
      `SELECT order_no, user_id, sku, amount_cents, status, created_at, reported_at, paid_at, handled_by, note FROM mcp_order ${w} ORDER BY id DESC LIMIT ?`,
      status ? [status, Math.min(500, limit)] : [Math.min(500, limit)]
    );
  }

  /** 经营看板：用户、收入、调用、点数消耗。 */
  async stats(days = 30) {
    await this.ensureSchema();
    const d = Math.max(1, Math.min(180, Math.floor(days)));
    const one = async (sql: string, params: any[] = []) =>
      (await this.q(sql, params))?.[0] || {};
    const users = await one(
      'SELECT COUNT(*) total, SUM(tier_expire_at IS NOT NULL AND tier_expire_at > NOW()) paying, ' +
        'SUM(points) points_outstanding FROM mcp_account'
    );
    const revenue = await one(
      "SELECT COALESCE(SUM(amount_cents),0) paid_cents, COUNT(*) paid_orders FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test' AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY)",
      [d]
    );
    const revenueMonth = await one(
      "SELECT COALESCE(SUM(amount_cents),0) paid_cents, COUNT(*) paid_orders FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')"
    );
    const pending = await one(
      "SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM mcp_order WHERE status = 'self_reported'"
    );
    const daily = await this.q(
      'SELECT DATE(created_at) day, ' +
        "SUM(CASE WHEN reason = 'call' THEN 1 ELSE 0 END) calls, " +
        "SUM(CASE WHEN reason = 'call' THEN -delta ELSE 0 END) points_used, " +
        "SUM(CASE WHEN reason = 'refund' THEN delta ELSE 0 END) points_refunded " +
        'FROM mcp_points_ledger WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(created_at) ORDER BY day',
      [d]
    );
    const dailyRevenue = await this.q(
      "SELECT DATE(paid_at) day, SUM(amount_cents) cents, COUNT(*) orders FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test' AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(paid_at) ORDER BY day",
      [d]
    );
    const bySku = await this.q(
      "SELECT sku, COUNT(*) orders, SUM(amount_cents) cents FROM mcp_order WHERE status = 'paid' AND sku <> 'pay_test' AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY sku ORDER BY cents DESC",
      [d]
    );
    const topTools = await this.q(
      // 失败调用会以 refund 退回同一工具的点数：calls 是扣点次数，failed 是退点次数，points 是净消耗
      "SELECT ref tool, SUM(reason = 'call') calls, SUM(reason = 'refund') failed, SUM(-delta) points FROM mcp_points_ledger WHERE reason IN ('call', 'refund') AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY ref ORDER BY calls DESC LIMIT 20",
      [d]
    );
    const num = (v: any) => Number(v || 0);
    const usage = await this.usageStats(d).catch(() => null);
    return {
      days: d,
      phase: currentPhase(),
      usage,
      users: {
        total: num(users.total),
        paying: num(users.paying),
        pointsOutstanding: num(users.points_outstanding),
      },
      revenue: {
        windowCents: num(revenue.paid_cents),
        windowOrders: num(revenue.paid_orders),
        monthCents: num(revenueMonth.paid_cents),
        monthOrders: num(revenueMonth.paid_orders),
        pendingConfirm: num(pending.n),
        pendingCents: num(pending.cents),
        basis: '以管理员确认到账的订单为准；个人收款码无自动到账核验',
      },
      daily,
      dailyRevenue,
      bySku,
      topTools,
    };
  }

  /**
   * 用量看板（免费期的核心数据：有没有人用、用得多不多、回不回来）。
   * 只统计用户自助开的 Key（管理员手发的测试 Key 不算），数据来自调用日志，与是否扣点无关。
   * wouldBePoints＝成功调用按单价折算的点数，免费期用来估算付费后的消耗。
   */
  async usageStats(days = 30) {
    const d = Math.max(1, Math.min(180, Math.floor(days)));
    const from = 'l.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
    const base =
      'FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id WHERE k.user_id IS NOT NULL AND ' +
      from;
    const num = (v: any) => Number(v || 0);
    const [totals] = await this.q(
      'SELECT COUNT(*) calls, SUM(l.ok = 0) failed, COUNT(DISTINCT k.user_id) users ' +
        base,
      [d]
    );
    const [repeat] = await this.q(
      'SELECT COUNT(*) n FROM (SELECT k.user_id ' +
        base +
        ' GROUP BY k.user_id HAVING COUNT(DISTINCT DATE(l.created_at)) >= 2) t',
      [d]
    );
    const [accounts] = await this.q(
      'SELECT COUNT(*) total, SUM(created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) recent FROM mcp_account',
      [d]
    );
    const [everCalled] = await this.q(
      'SELECT COUNT(DISTINCT k.user_id) n FROM mcp_call_log l JOIN mcp_api_key k ON k.id = l.key_id WHERE k.user_id IS NOT NULL'
    );
    const daily = await this.q(
      'SELECT DATE(l.created_at) day, COUNT(*) calls, SUM(l.ok = 0) failed, COUNT(DISTINCT k.user_id) users ' +
        base +
        ' GROUP BY DATE(l.created_at) ORDER BY day',
      [d]
    );
    const signups = await this.q(
      'SELECT DATE(created_at) day, COUNT(*) n FROM mcp_account WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(created_at) ORDER BY day',
      [d]
    );
    const tools = (
      await this.q(
        'SELECT l.product, l.tool, COUNT(*) calls, SUM(l.ok = 0) failed, COUNT(DISTINCT k.user_id) users ' +
          base +
          ' GROUP BY l.product, l.tool ORDER BY calls DESC LIMIT 30',
        [d]
      )
    ).map((r: any) => ({
      product: r.product,
      tool: r.tool,
      calls: num(r.calls),
      failed: num(r.failed),
      users: num(r.users),
      wouldBePoints: (num(r.calls) - num(r.failed)) * toolCost(r.tool),
    }));
    const topUsers = await this.q(
      'SELECT k.user_id, COUNT(*) calls, COUNT(DISTINCT DATE(l.created_at)) active_days, MAX(l.created_at) last_at ' +
        base +
        ' GROUP BY k.user_id ORDER BY calls DESC LIMIT 20',
      [d]
    );
    return {
      basis: '只统计用户自助开的 Key；管理员测试 Key 不计入',
      activeUsers: num(totals?.users),
      repeatUsers: num(repeat?.n),
      calls: num(totals?.calls),
      failed: num(totals?.failed),
      wouldBePoints: tools.reduce(
        (a: number, t: any) => a + t.wouldBePoints,
        0
      ),
      accounts: num(accounts?.total),
      newAccounts: num(accounts?.recent),
      everCalledUsers: num(everCalled?.n),
      daily: daily.map((r: any) => ({
        day: r.day,
        calls: num(r.calls),
        failed: num(r.failed),
        users: num(r.users),
      })),
      signups: signups.map((r: any) => ({ day: r.day, n: num(r.n) })),
      tools,
      topUsers: topUsers.map((r: any) => ({
        userId: r.user_id,
        calls: num(r.calls),
        activeDays: num(r.active_days),
        lastAt: r.last_at,
      })),
    };
  }
}
