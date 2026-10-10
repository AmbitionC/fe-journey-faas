/**
 * Personal OS 纯函数层：净资产汇总、数据新鲜度、缺口清单、随手记规则分类、事件结转。
 * 不碰数据库，便于单测钉死口径（PRD v0.2 §10 指标口径 / §2.3 事实类型）。
 */

export type FactType =
  | 'measured'
  | 'reported'
  | 'imported'
  | 'estimated'
  | 'inferred'
  | 'planned'
  | 'derived'
  | 'superseded'
  | 'unknown';

export const DOMAINS = [
  'wealth',
  'career',
  'health',
  'time',
  'family',
  'growth',
  'risk',
  'life',
] as const;

export const NOTE_KINDS = [
  'note',
  'idea',
  'worry',
  'plan',
  'decision',
  'event',
  'feeling',
] as const;

/** 北京时间今天 YYYY-MM-DD（FC 实例时区不可控）。 */
export function todayCN(now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 北京时间当前 YYYY-MM-DD HH:mm:ss。 */
export function nowCN(now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

/** 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY-MM-DD HH:mm:ss' → 'YYYY-MM-DD'。 */
export function normDate(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
  );
}

export function isDate(s: any): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ---------------------------------------------------------------- 新鲜度

/** 各数据源「超过多少天算陈旧」（PRD 规划 §6.2，周末节假日对行情放宽到 5 天）。 */
export const STALE_DAYS: Record<string, number> = {
  invest_a: 5,
  fx: 10,
  body_weight: 7,
  body_fat: 30,
  activity: 2,
  meals: 1,
  balance: 40,
  income: 40,
  growth: 2,
  waist: 14,
  notes: 14,
};

export type Freshness = 'fresh' | 'stale' | 'missing';

export function freshness(
  source: string,
  asOf: string | null,
  today: string
): { status: Freshness; ageDays: number | null } {
  if (!asOf) return { status: 'missing', ageDays: null };
  const age = daysBetween(asOf, today);
  const limit = STALE_DAYS[source] ?? 30;
  return { status: age > limit ? 'stale' : 'fresh', ageDays: age };
}

// ---------------------------------------------------------------- 净资产

export interface BalanceLine {
  key: string; // 'pos:12' | 'invest_a'
  name: string;
  kind: string;
  side: 'asset' | 'liability';
  currency: string;
  amount: number | null; // 原币
  low?: number | null;
  high?: number | null;
  asOf: string | null;
  factType: FactType | string;
  source: string;
  liquid: boolean;
  investable: boolean;
  includeNetWorth: boolean;
  freshness?: Freshness;
}

export interface FxRate {
  rate: number;
  asOf: string;
  source: string;
}

export interface WealthSummary {
  lines: Array<BalanceLine & { amountCny: number | null; fxMissing: boolean }>;
  totalAssets: number | null;
  totalLiabilities: number | null;
  netWorth: number | null;
  investable: number | null;
  liquidCash: number | null;
  approximate: boolean; // 有区间/自述值参与
  partial: boolean; // 有成分缺失（缺汇率 / 无余额）
  staleParts: string[];
  missingParts: string[];
  hasLiabilityRecord: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 资产负债汇总（PRD §10.1）：净资产 = 资产 − 负债；自住房等 include_networth=0 的不计入；
 * 外币按给定日期的汇率折算，汇率缺失时该行不折算并标记 partial（绝不默认汇率）。
 * 区间值取中位数并标记 approximate。
 */
export function summarizeWealth(
  lines: BalanceLine[],
  fx: Record<string, FxRate | null>
): WealthSummary {
  let assets = 0;
  let liabilities = 0;
  let investable = 0;
  let liquid = 0;
  let approximate = false;
  let partial = false;
  let anyValue = false;
  const staleParts: string[] = [];
  const missingParts: string[] = [];
  const out: WealthSummary['lines'] = [];

  for (const l of lines) {
    let amt = l.amount;
    if (amt == null && l.low != null && l.high != null) amt = (l.low + l.high) / 2;
    if (l.low != null && l.high != null && l.low !== l.high) approximate = true;
    if (l.factType === 'reported' || l.factType === 'estimated') approximate = true;
    if (l.freshness === 'stale') staleParts.push(l.name);

    let amountCny: number | null = null;
    let fxMissing = false;
    if (amt == null) {
      missingParts.push(l.name);
      partial = true;
    } else if (l.currency === 'CNY') {
      amountCny = amt;
    } else {
      const r = fx[l.currency];
      if (r && r.rate > 0) amountCny = round2(amt * r.rate);
      else {
        fxMissing = true;
        partial = true;
        missingParts.push(`${l.name}（缺 ${l.currency} 汇率）`);
      }
    }
    out.push({ ...l, amount: amt, amountCny, fxMissing });
    if (amountCny == null || !l.includeNetWorth) continue;
    anyValue = true;
    if (l.side === 'liability') liabilities += amountCny;
    else {
      assets += amountCny;
      if (l.investable) investable += amountCny;
      if (l.liquid) liquid += amountCny;
    }
  }

  const hasLiabilityRecord = lines.some(l => l.side === 'liability');
  return {
    lines: out,
    totalAssets: anyValue ? round2(assets) : null,
    totalLiabilities: anyValue ? round2(liabilities) : null,
    netWorth: anyValue ? round2(assets - liabilities) : null,
    investable: anyValue ? round2(investable) : null,
    liquidCash: anyValue ? round2(liquid) : null,
    approximate,
    partial,
    staleParts,
    missingParts,
    hasLiabilityRecord,
  };
}

// ---------------------------------------------------------------- 事件结转

export interface EventEffect {
  accountId: number;
  delta: number;
}

/**
 * 计划事件 → 已执行：给定各账户结转日前的最新余额，算出结转日的新余额。
 * 负债余额按「欠款为正」记，还贷就是负债 delta 为负、资金账户 delta 为负。
 * 同一账户多次出现时累加。
 */
export function applyEffects(
  prevBalances: Record<number, number | null>,
  effects: EventEffect[]
): Array<{ accountId: number; prev: number; next: number }> {
  const acc: Record<number, number> = {};
  for (const e of effects) {
    if (!Number.isFinite(e.delta) || e.delta === 0) continue;
    acc[e.accountId] = (acc[e.accountId] || 0) + e.delta;
  }
  return Object.entries(acc).map(([id, delta]) => {
    const accountId = Number(id);
    const prev = prevBalances[accountId];
    if (prev == null)
      throw new Error(`账户 #${accountId} 在结转日前没有余额记录，无法结转`);
    return { accountId, prev, next: round2(prev + delta) };
  });
}

// ---------------------------------------------------------------- 随手记规则分类

const PLAN_WORDS = /(打算|计划|准备|想要|下周|下个月|明天|后天|月底|年底|将要|要去|安排|争取|回头)/;
const DONE_WORDS = /(已经|今天(?!打算)|刚刚|完成了|做完|买了|还了|发布了|上线了|搞定)/;
const DECISION_WORDS = /(决定|定了|拍板|放弃|不做了|选了|选择)/;
const WORRY_WORDS = /(担心|焦虑|害怕|压力|纠结|烦|不安|困惑)/;
const IDEA_WORDS = /(想法|灵感|也许可以|或许可以|可以试试|点子|突然觉得|要不要)/;
const FEELING_WORDS = /(开心|难过|累|疲惫|满足|沮丧|兴奋|感觉)/;

const DOMAIN_RULES: Array<[string, RegExp]> = [
  ['wealth', /(股|基金|房贷|还贷|存款|现金|理财|资产|负债|投资|仓位|美股|A股|ETF|利率|贷款)/i],
  ['career', /(工作|老板|绩效|工资|奖金|期权|副业|产品|用户|订单|营收|客户|同事|面试|升职)/],
  ['health', /(体重|体脂|跑步|健身|睡眠|饮食|吃|运动|减脂|腰围|体检|血压|快走|步数)/],
  ['family', /(老婆|妻子|孩子|儿子|女儿|父母|爸|妈|家人|家庭|陪)/],
  ['growth', /(学习|读书|看书|课程|写作|文章|技能|英语|笔记)/],
  ['time', /(时间|精力|加班|日程|效率|拖延)/],
  ['risk', /(保险|风险|备份|密码|应急)/],
];

/** LLM 不可用时的兜底分类：只给 kind/domain 建议，不生成任何事实。 */
export function classifyNoteByRule(text: string): {
  kind: string;
  domain: string | null;
} {
  const t = String(text || '');
  let kind = 'note';
  if (DECISION_WORDS.test(t)) kind = 'decision';
  else if (PLAN_WORDS.test(t) && !DONE_WORDS.test(t)) kind = 'plan';
  else if (WORRY_WORDS.test(t)) kind = 'worry';
  else if (IDEA_WORDS.test(t)) kind = 'idea';
  else if (DONE_WORDS.test(t)) kind = 'event';
  else if (FEELING_WORDS.test(t)) kind = 'feeling';
  const hit = DOMAIN_RULES.find(([, re]) => re.test(t));
  return { kind, domain: hit ? hit[0] : null };
}

/**
 * 计划/已发生 护栏（PRD §6.3）：原文含「打算/计划…」而没有「已经/完成」等字样时，
 * 无论模型怎么说，事件候选一律强制为 planned——计划永远不能被当成已发生。
 */
export function guardEventStatus(text: string, status: string): 'planned' | 'done' {
  const t = String(text || '');
  if (PLAN_WORDS.test(t) && !DONE_WORDS.test(t)) return 'planned';
  return status === 'done' ? 'done' : 'planned';
}

// ---------------------------------------------------------------- 缺口清单

export interface GapInput {
  today: string;
  hasCashAccount: boolean;
  hasLiability: boolean;
  salaryLatest: { period: string; basis: string } | null;
  overduePlanned: Array<{ id: number; title: string; plannedDate: string }>;
  investA: string | null;
  fxMissing: boolean;
  bodyFatAsOf: string | null;
  weightAsOf: string | null;
  waistAsOf: string | null;
  goalsCount: number;
  factsCount: number;
}

export interface Gap {
  key: string;
  domain: string;
  level: 'high' | 'medium' | 'low';
  text: string;
  action?: string; // 前端跳转用路由
}

/** 「系统还缺什么」——按对当前判断的影响排序（PRD §19）。 */
export function computeGaps(g: GapInput): Gap[] {
  const out: Gap[] = [];
  for (const e of g.overduePlanned) {
    out.push({
      key: `overdue:${e.id}`,
      domain: 'life',
      level: 'high',
      text: `计划事件「${e.title}」已过计划日期（${e.plannedDate}），实际执行了吗？`,
      action: '/records?tab=events',
    });
  }
  if (!g.hasLiability)
    out.push({
      key: 'liability',
      domain: 'wealth',
      level: 'high',
      text: '还没录入房贷/负债，净资产只算了资产一侧',
      action: '/wealth?tab=accounts',
    });
  if (!g.hasCashAccount)
    out.push({
      key: 'cash',
      domain: 'wealth',
      level: 'high',
      text: '现金/银行余额未录入（注意别和券商账户里的现金重复）',
      action: '/wealth?tab=accounts',
    });
  if (!g.salaryLatest)
    out.push({
      key: 'salary',
      domain: 'career',
      level: 'medium',
      text: '主业收入未录入',
      action: '/wealth?tab=income',
    });
  else if (g.salaryLatest.basis === 'unknown')
    out.push({
      key: 'salary_basis',
      domain: 'career',
      level: 'medium',
      text: '工资未注明税前还是税后，储蓄率无法计算',
      action: '/wealth?tab=income',
    });
  if (!g.investA)
    out.push({
      key: 'invest_a',
      domain: 'wealth',
      level: 'medium',
      text: 'A 股账户快照为空（invest 系统未录入持仓快照）',
    });
  if (g.fxMissing)
    out.push({
      key: 'fx',
      domain: 'wealth',
      level: 'medium',
      text: '缺少美元兑人民币汇率，美元资产未折算进净资产',
      action: '/wealth?tab=accounts',
    });
  if (!g.bodyFatAsOf || daysBetween(g.bodyFatAsOf, g.today) > 30)
    out.push({
      key: 'body_fat',
      domain: 'health',
      level: 'medium',
      text: g.bodyFatAsOf
        ? `体脂已 ${daysBetween(g.bodyFatAsOf, g.today)} 天没测（同一台秤、晨起空腹）`
        : '还没有体脂实测基线',
      action: '/health?tab=body',
    });
  if (!g.weightAsOf || daysBetween(g.weightAsOf, g.today) > 7)
    out.push({
      key: 'weight',
      domain: 'health',
      level: 'low',
      text: '超过一周没称体重',
      action: '/health?tab=body',
    });
  if (!g.waistAsOf)
    out.push({
      key: 'waist',
      domain: 'health',
      level: 'low',
      text: '腰围还没记录（每周一次即可）',
      action: '/health?tab=body',
    });
  if (g.goalsCount === 0)
    out.push({
      key: 'goals',
      domain: 'life',
      level: 'medium',
      text: '还没写下当前最重要的 1–3 个方向',
      action: '/me?tab=goals',
    });
  if (g.factsCount === 0)
    out.push({
      key: 'facts',
      domain: 'life',
      level: 'low',
      text: '「关于我」还是空的：价值排序、底线、风险偏好',
      action: '/me?tab=about',
    });
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** 简单移动平均（用于体重 7 日均线）。 */
export function movingAvg(
  points: Array<{ date: string; value: number }>,
  windowDays = 7
): Array<{ date: string; value: number }> {
  return points.map(p => {
    const win = points.filter(
      q => daysBetween(q.date, p.date) >= 0 && daysBetween(q.date, p.date) < windowDays
    );
    const avg = win.reduce((s, q) => s + q.value, 0) / win.length;
    return { date: p.date, value: Math.round(avg * 100) / 100 };
  });
}

// ---------------------------------------------------------------- 身体成分 / 睡眠 / 力量训练

/**
 * 肌肉量变化与掉肌判断：取最近一条有肌肉量的体成分记录，与 ≥21 天前最近的一条比
 * （没有那么早的，用最早一条，但跨度要 ≥14 天）。体重在降、肌肉量降 ≥0.5 kg 判为掉肌。
 */
export function muscleTrend(
  records: Array<{ date: string; weightKg: number; muscleMassKg: number | null }>,
  minGapDays = 21
): {
  value: number;
  asOf: string;
  delta: number | null;
  deltaWeight: number | null;
  days: number | null;
  loss: boolean;
  lossShare: number | null;
} | null {
  const withM = records
    .filter(r => r.muscleMassKg != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = withM[withM.length - 1];
  if (!last) return null;
  const earlier = withM.filter(r => daysBetween(r.date, last.date) >= minGapDays);
  const ref = earlier.length
    ? earlier[earlier.length - 1]
    : withM[0] && daysBetween(withM[0].date, last.date) >= 14
      ? withM[0]
      : null;
  if (!ref) return { value: last.muscleMassKg!, asOf: last.date, delta: null, deltaWeight: null, days: null, loss: false, lossShare: null };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const delta = r2(last.muscleMassKg! - ref.muscleMassKg!);
  const deltaWeight = r2(last.weightKg - ref.weightKg);
  const loss = deltaWeight < 0 && delta <= -0.5;
  return {
    value: last.muscleMassKg!,
    asOf: last.date,
    delta,
    deltaWeight,
    days: daysBetween(ref.date, last.date),
    loss,
    lossShare: loss ? Math.round((-delta / -deltaWeight) * 100) / 100 : null,
  };
}

/** 近 7 天平均睡眠（有记录的天才算），低于 7 小时标为不足。 */
export function sleepSummary(
  days: Array<{ date: string; sleepHours: number | null }>,
  today: string
): { avg7: number; nights: number; short: boolean; series: Array<{ date: string; hours: number | null }> } | null {
  const inRange = (d: string, n: number) => {
    const diff = daysBetween(d, today);
    return diff >= 0 && diff < n;
  };
  const last7 = days.filter(a => a.sleepHours != null && a.sleepHours > 0 && inRange(a.date, 7));
  if (!last7.length) return null;
  const avg7 = Math.round((last7.reduce((s, a) => s + (a.sleepHours as number), 0) / last7.length) * 10) / 10;
  const series = days
    .filter(a => inRange(a.date, 14))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(a => ({ date: a.date, hours: a.sleepHours }));
  return { avg7, nights: last7.length, short: avg7 < 7, series };
}

const STRENGTH_RE = /strength|resistance|weight|力量|抗阻|举重|器械|功能性/i;

/**
 * 近 7 天做过力量训练的天数。14 天内一条训练记录都没有时返回 null
 * （分不清是没练还是快捷指令没带训练数据，不臆造成 0）。
 */
export function strengthDays(
  days: Array<{ date: string; workouts: Array<{ type: string }> }>,
  today: string
): number | null {
  const recent = days.filter(a => {
    const diff = daysBetween(a.date, today);
    return diff >= 0 && diff < 14;
  });
  if (!recent.some(a => (a.workouts || []).length)) return null;
  return recent.filter(
    a => daysBetween(a.date, today) < 7 && (a.workouts || []).some(w => STRENGTH_RE.test(String(w.type || '')))
  ).length;
}
