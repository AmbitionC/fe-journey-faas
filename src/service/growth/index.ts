import { Provide, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user';
import { OrderEntity } from '../../entity/order';
import { BookOrderEntity } from '../../entity/bookOrder';
import { EventLogEntity } from '../../entity/eventLog';
import { AiUsageLogEntity } from '../../entity/aiUsageLog';
import { GrowthStatEntity } from '../../entity/growthStat';
import { GrowthReviewEntity } from '../../entity/growthReview';

/** 高价 SKU 的订单类型（order.type）；破冰 SKU = pdf + 书籍订单 */
const HIGH_VALUE_ORDER_TYPES = ['member', 'consult'];

/**
 * AI 用量按「谁在花」归类。**这是一道脱敏边界，不是格式化**：
 * ai_usage_log.userId 对真人就是手机号，而复盘导出是免登录（x-sync-secret）的，
 * 所以真人一侧只能出计数，**只有非手机号形态的系统标识可以原样列出**
 * （eval-bot / review / plan-ai / coach-plan 这类调用方自己传的假 userId）。
 * 抽成纯函数是为了让这条边界可被测试直接钉住（见 test/aiUsageSubjects.test.ts）。
 */
export function classifyAiSubjects(
  rows: { id?: string | null; calls?: number | string; tokens?: number | string }[]
): {
  bySubject: { subject: string; calls: number; tokens: number; distinct: number }[];
  systemIds: { id: string; calls: number; tokens: number }[];
} {
  const isHuman = (id: string) => /^\d{11}$/.test(id);
  // 能否原样打印，是一条**白名单**规则，与归桶分开判。
  // 先前写成「不是 11 位手机号就打印」，被用例逮到：`+8617394940726`、
  // `173-9494-0726` 都不满足 11 位纯数字，于是会被当系统标识原样输出——
  // 免登录接口上就是泄号码。改为只放行「系统标识长相」：字母开头、
  // 仅含字母数字下划线连字符，且不含 7 位以上连续数字。
  const isPrintable = (id: string) =>
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && !/\d{7,}/.test(id);
  const human = { subject: '真人账号', calls: 0, tokens: 0, distinct: 0 };
  const system = { subject: '系统任务', calls: 0, tokens: 0, distinct: 0 };
  const systemIds: { id: string; calls: number; tokens: number }[] = [];

  for (const r of rows || []) {
    const id = String(r?.id ?? '');
    const calls = Number(r?.calls || 0);
    const tokens = Number(r?.tokens || 0);
    const bucket = isHuman(id) ? human : system;
    bucket.calls += calls;
    bucket.tokens += tokens;
    bucket.distinct += 1;
    if (isHuman(id)) continue;
    // 非真人一律计数；只有过了白名单的标识才带上原文，其余脱敏后仍可见其存在
    systemIds.push({
      id: isPrintable(id) ? id : id === '' ? '(空)' : '(其他标识)',
      calls,
      tokens,
    });
  }
  systemIds.sort((a, b) => b.calls - a.calls);
  return { bySubject: [human, system], systemIds };
}

/**
 * 增长复盘系统（数据口径见 front-end-journey 仓库 docs/growth-review-playbook.md）。
 * 漏斗四层：访问(uv) → 注册 → 破冰付费(pdf/书) → 高价付费(会员/咨询)。
 * 站内数据实时聚合（量级小无需预算表）；站外数据走 growth_stat 手动录入。
 */
@Provide()
export class GrowthService {
  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @InjectEntityModel(OrderEntity)
  orderModel: Repository<OrderEntity>;

  @InjectEntityModel(BookOrderEntity)
  bookOrderModel: Repository<BookOrderEntity>;

  @InjectEntityModel(EventLogEntity)
  eventLogModel: Repository<EventLogEntity>;

  @InjectEntityModel(AiUsageLogEntity)
  aiUsageLogModel: Repository<AiUsageLogEntity>;

  @InjectEntityModel(GrowthStatEntity)
  growthStatModel: Repository<GrowthStatEntity>;

  @InjectEntityModel(GrowthReviewEntity)
  growthReviewModel: Repository<GrowthReviewEntity>;

  @Config('growthInternalUserIds')
  internalUserIds: string[];

  /**
   * 内部/自测账号排除口径：config（GROWTH_INTERNAL_USER_IDS）∪ 调用方额外传入的 id。
   * 返回去重后的手机号数组；所有涉及 userId/phoneNumber 的聚合都据此过滤。
   * 注：event_log.userId 可空（匿名事件），相关查询用
   * `(userId IS NULL OR userId NOT IN (...))`，只剔除指定账号、保留匿名/游客事件。
   */
  private excludedUserIds(extra?: string[]): string[] {
    const merged = [...(this.internalUserIds || []), ...(extra || [])]
      .map((s) => String(s).trim())
      .filter(Boolean);
    return Array.from(new Set(merged));
  }

  /** 某指标最近一次录入值 */
  private async latestStat(metric: string): Promise<{ value: number; statDate: string } | null> {
    const row = await this.growthStatModel.findOne({
      where: { metric },
      order: { statDate: 'DESC' },
    });
    return row ? { value: Number(row.value), statDate: row.statDate } : null;
  }

  /** 时间段内已支付订单的数量与金额（order + book_order 合并） */
  private async paidOrders(since: Date, until?: Date, exclude?: string[]) {
    const ex = this.excludedUserIds(exclude);
    const qb1 = this.orderModel
      .createQueryBuilder('o')
      .select('o.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(o.amount)', 'amount')
      .where("o.status = 'paid'")
      .andWhere('o.payTime >= :since', { since })
      .groupBy('o.type');
    if (until) qb1.andWhere('o.payTime < :until', { until });
    if (ex.length) qb1.andWhere('o.userId NOT IN (:...ex)', { ex });
    const orders = await qb1.getRawMany();

    const qb2 = this.bookOrderModel
      .createQueryBuilder('b')
      .select('COUNT(*)', 'count')
      .addSelect('SUM(b.amount)', 'amount')
      .where("b.status = 'paid'")
      .andWhere('b.payTime >= :since', { since });
    if (until) qb2.andWhere('b.payTime < :until', { until });
    if (ex.length) qb2.andWhere('b.userId NOT IN (:...ex)', { ex });
    const book = await qb2.getRawOne();

    const byType: Record<string, { count: number; amount: number }> = {};
    for (const r of orders) {
      byType[r.type] = { count: Number(r.count), amount: Number(r.amount || 0) };
    }
    byType.book = { count: Number(book?.count || 0), amount: Number(book?.amount || 0) };
    return byType;
  }

  /**
   * 北极星概览：本月收入/成本/净现金流（第一里程碑：收入 ≥ 成本）+ 私域/小红书存量。
   */
  async overview(exclude?: string[]) {
    const ex = this.excludedUserIds(exclude);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const byType = await this.paidOrders(monthStart, undefined, exclude);
    const monthRevenue = Object.values(byType).reduce((s, v) => s + v.amount, 0);
    const monthOrderCount = Object.values(byType).reduce((s, v) => s + v.count, 0);

    const [cost, groupMembers, xhsFollowers] = await Promise.all([
      this.latestStat('monthly_cost'),
      this.latestStat('group_members'),
      this.latestStat('xhs_followers'),
    ]);

    let monthNewUsers = 0;
    try {
      const qb = this.userModel
        .createQueryBuilder('u')
        .where('u.createTime >= :since', { since: monthStart });
      if (ex.length) qb.andWhere('u.phoneNumber NOT IN (:...ex)', { ex });
      monthNewUsers = await qb.getCount();
    } catch {
      /* ignore */
    }

    const monthCost = cost?.value ?? null;
    return {
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      monthRevenue,
      monthOrderCount,
      monthRevenueByType: byType,
      monthCost,
      netCashflow: monthCost == null ? null : Number((monthRevenue - monthCost).toFixed(2)),
      breakeven: monthCost == null ? null : monthRevenue >= monthCost,
      monthNewUsers,
      groupMembers: groupMembers?.value ?? null,
      groupMembersDate: groupMembers?.statDate ?? null,
      xhsFollowers: xhsFollowers?.value ?? null,
      xhsFollowersDate: xhsFollowers?.statDate ?? null,
    };
  }

  /**
   * 转化漏斗（近 N 天）：uv → 注册 → 破冰付费(pdf+书) → 高价付费(member/consult)。
   * uv 口径 = event_log 里 page_view 事件的去重 userId（游客为 guest:ip）。
   */
  async funnel(days = 30, exclude?: string[]) {
    const since = new Date(Date.now() - days * 86400000);
    const ex = this.excludedUserIds(exclude);

    let uv = 0;
    try {
      const qb = this.eventLogModel
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.userId)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since });
      if (ex.length) qb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      const row = await qb.getRawOne();
      uv = Number(row?.uv || 0);
    } catch {
      /* ignore */
    }

    // uvByIp：按去重 IP 数的访问量。**在 2026-09-06 之前，这才是唯一可信的流量读数。**
    // 上面的 uv 数的是去重 userId，而在那天之前游客的 userId 一直落空串——
    // 所有未登录访客被并进同一个桶，UV 实际上只数了登录用户。ip 列从建表起就
    // 一直有值，因此这个口径**对全部历史都成立**，可以直接回看被低估了多少。
    // 修好之后两者会趋同（游客改落 guest:<ip>），但历史段仍以本列为准。
    let uvByIp = 0;
    try {
      const qb = this.eventLogModel
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.ip)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .andWhere("e.ip IS NOT NULL AND e.ip <> ''");
      if (ex.length) qb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      const row = await qb.getRawOne();
      uvByIp = Number(row?.uv || 0);
    } catch {
      /* ignore */
    }

    let signups = 0;
    try {
      const qb = this.userModel
        .createQueryBuilder('u')
        .where('u.createTime >= :since', { since });
      if (ex.length) qb.andWhere('u.phoneNumber NOT IN (:...ex)', { ex });
      signups = await qb.getCount();
    } catch {
      /* ignore */
    }

    // 访问质量：把「151 个 IP」拆成机器人 / 一次性 / 真在翻页三类。
    // uvByIp 一出来就必须配这个——不然只是把一个不可信的数换成另一个：
    // 爬虫会打 page_view（前端路由上报，Googlebot 一类会跑 JS），而
    // 「有流量但零转化」和「根本没流量」是两个完全不同的问题，不能混着答。
    // UA 只做模式匹配、不落任何原文；IP 只出计数。
    const visitQuality = { ips: uvByIp, botIps: 0, singlePageIps: 0, multiPageIps: 0 };
    try {
      const qb = this.eventLogModel
        .createQueryBuilder('e')
        .select('e.ip', 'ip')
        .addSelect('COUNT(*)', 'hits')
        .addSelect(
          "MAX(CASE WHEN LOWER(COALESCE(e.ua, '')) REGEXP 'bot|spider|crawl|slurp|headless|python-requests|curl/|wget|scrapy|http-client' THEN 1 ELSE 0 END)",
          'bot'
        )
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .andWhere("e.ip IS NOT NULL AND e.ip <> ''")
        .groupBy('e.ip');
      if (ex.length) qb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      for (const r of await qb.getRawMany()) {
        if (Number(r.bot) === 1) visitQuality.botIps += 1;
        else if (Number(r.hits) <= 1) visitQuality.singlePageIps += 1;
        else visitQuality.multiPageIps += 1;
      }
    } catch {
      /* ignore */
    }

    const byType = await this.paidOrders(since, undefined, exclude);
    const icebreaker =
      (byType.pdf?.count || 0) + (byType.book?.count || 0);
    const icebreakerAmount =
      (byType.pdf?.amount || 0) + (byType.book?.amount || 0);
    const highValue = HIGH_VALUE_ORDER_TYPES.reduce(
      (s, t) => s + (byType[t]?.count || 0),
      0
    );
    const highValueAmount = HIGH_VALUE_ORDER_TYPES.reduce(
      (s, t) => s + (byType[t]?.amount || 0),
      0
    );

    const rate = (a: number, b: number) =>
      b > 0 ? Number(((a / b) * 100).toFixed(2)) : null;

    return {
      days,
      // 三类之和 = countByIp。multiPageIps 是「翻过不止一页的非爬虫 IP」，
      // 最接近「真人访客」；singlePageIps 里混着一次性访问与不带 bot 特征的抓取。
      visitQuality,
      stages: [
        { key: 'visit', label: '访问 UV', count: uv, countByIp: uvByIp },
        { key: 'signup', label: '注册', count: signups, rateFromPrev: rate(signups, uvByIp || uv) },
        {
          key: 'icebreaker',
          label: '破冰付费(PDF/书)',
          count: icebreaker,
          amount: icebreakerAmount,
          rateFromPrev: rate(icebreaker, signups),
        },
        {
          key: 'highValue',
          label: '高价付费(会员/咨询)',
          count: highValue,
          amount: highValueAmount,
          rateFromPrev: rate(highValue, icebreaker),
        },
      ],
    };
  }


  /**
   * 注册来源体检（近 N 天）——纯聚合，**不返回任何手机号/昵称等个人信息**。
   *
   * 起因（2026-08-30 复盘）：近 30 天注册 45 人，而同期 page_view UV 只有 7、
   * signup_success 埋点只有 4 条。漏斗把「注册/UV」算成 642% 却没人能说清这 45 人
   * 是谁——前端唯一的注册入口 loginModal 成功后必发 signup_success，因此绝大多数
   * 注册没走前端。可能是共用 user 表的另一个前端（invest-journey），也可能是脚本
   * 批量注册；两者的处置完全相反，**不能靠猜**。8/16 已立过规矩：引用漏斗事件前
   * 先确认它的触发条件，n=1 时连事件语义都可能是错的。
   *
   * 判据（按信息量排序）：
   * - burst.maxPerMinute / minutesUsed：真人注册散落在各分钟里；脚本会挤在同一分钟。
   * - silent：注册后完全没有事件/AI/阅读记录的人数。真人注册即带 page_view。
   * - signupSuccessEvents vs signups：差额就是「没走本站前端」的注册数。
   */
  async signupAudit(days = 30, exclude?: string[]) {
    const since = new Date(Date.now() - days * 86400000);
    const ex = this.excludedUserIds(exclude);

    const newUsers = async () => {
      const qb = this.userModel
        .createQueryBuilder('u')
        .select('u.phoneNumber', 'id')
        .addSelect("DATE_FORMAT(u.createTime, '%Y-%m-%d')", 'day')
        .addSelect("DATE_FORMAT(u.createTime, '%Y-%m-%d %H:%i')", 'minute')
        .addSelect('u.nickName', 'nickName')
        .where('u.createTime >= :since', { since });
      if (ex.length) qb.andWhere('u.phoneNumber NOT IN (:...ex)', { ex });
      return qb.getRawMany();
    };

    let rows: any[] = [];
    try {
      rows = await newUsers();
    } catch {
      return { days, error: 'query_failed' };
    }

    const ids = rows.map((r) => String(r.id)).filter(Boolean);
    const signups = rows.length;

    // 按天 / 按分钟聚合（分钟串不含个人信息，只用来看是否挤成一簇）
    const dayMap: Record<string, number> = {};
    const minuteMap: Record<string, number> = {};
    let autoNickname = 0;
    for (const r of rows) {
      dayMap[r.day] = (dayMap[r.day] || 0) + 1;
      minuteMap[r.minute] = (minuteMap[r.minute] || 0) + 1;
      // 前端注册框昵称留空时自动生成「用户_HHMMSS」
      if (/^用户_\d{6}$/.test(String(r.nickName || ''))) autoNickname += 1;
    }
    const byDay = Object.keys(dayMap)
      .sort()
      .map((date) => ({ date, count: dayMap[date] }));
    const minuteEntries = Object.entries(minuteMap).sort((a, b) => b[1] - a[1]);

    // 注册后是否留下过任何痕迹（三张表任一有记录即算「活过」）
    const distinctIn = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: Repository<any>,
      alias: string,
      col = 'userId'
    ): Promise<Set<string>> => {
      if (!ids.length) return new Set();
      try {
        const raw = await model
          .createQueryBuilder(alias)
          .select(`${alias}.${col}`, 'id')
          .where(`${alias}.${col} IN (:...ids)`, { ids })
          .groupBy(`${alias}.${col}`)
          .getRawMany();
        return new Set(raw.map((r) => String(r.id)));
      } catch {
        return new Set();
      }
    };

    const [eventUsers, aiUsers] = await Promise.all([
      distinctIn(this.eventLogModel, 'e'),
      distinctIn(this.aiUsageLogModel, 'a'),
    ]);
    const alive = new Set<string>([...eventUsers, ...aiUsers]);

    let signupSuccessEvents = 0;
    try {
      const qb = this.eventLogModel
        .createQueryBuilder('e')
        .where("e.event = 'signup_success'")
        .andWhere('e.createTime >= :since', { since });
      if (ex.length) qb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      signupSuccessEvents = await qb.getCount();
    } catch {
      /* ignore */
    }

    return {
      days,
      signups,
      byDay,
      burst: {
        minutesUsed: minuteEntries.length,
        maxPerMinute: minuteEntries[0]?.[1] || 0,
        topMinutes: minuteEntries.slice(0, 5).map(([minute, count]) => ({ minute, count })),
      },
      // 注册后有过埋点事件 / AI 调用的人数；silent = 注册完毫无痕迹
      withEvent: eventUsers.size,
      withAiCall: aiUsers.size,
      silent: signups - alive.size,
      // 本站前端注册成功埋点数；与 signups 的差额 = 没走本站前端的注册
      signupSuccessEvents,
      notFromThisFrontend: Math.max(0, signups - signupSuccessEvents),
      autoNickname,
    };
  }


  /**
   * AI 用量拆解（近 N 天）——纯聚合，**不输出任何手机号**。
   *
   * 起因（2026-09-06 复盘）：本周站内 UV 只有 2、埋点事件一条没有、注册 0，
   * 而 aiCalls 从 1106 涨到 1143（+37）、token 从 78.3 万涨到 82.3 万（+4 万）。
   * 北极星是「月收入 ≥ 月成本」，token 又是唯一会自己长的可变成本，却没有任何
   * 数据能回答「这 37 次是谁打的、烧在哪个功能上」。
   *
   * 主体分类只看形态，不外泄标识：11 位纯数字＝真人账号（userId 就是手机号），
   * 其余是系统任务标识。**只有系统任务标识会被原样列出**（eval-bot / review /
   * plan-ai 这类），真人一侧永远只给计数。
   *
   * 注意 module 列目前区分度很低：completeRaw(system, user, 'review') 的第三个参数
   * 是 userId 不是 module，module 被写死成 'eval'——所以 review / plan-ai / coach-plan
   * 三条链路都堆在同一个 module 下，只能从 bySubject 的标识把它们分开。
   */
  async aiUsage(days = 30, exclude?: string[]) {
    const since = new Date(Date.now() - days * 86400000);
    const ex = this.excludedUserIds(exclude);

    const base = () => {
      const qb = this.aiUsageLogModel
        .createQueryBuilder('u')
        .where('u.createTime >= :since', { since });
      if (ex.length) qb.andWhere('u.userId NOT IN (:...ex)', { ex });
      return qb;
    };

    try {
      const totalRow = await base()
        .select('COUNT(*)', 'calls')
        .addSelect('COALESCE(SUM(u.tokenUsed), 0)', 'tokens')
        .getRawOne();

      const moduleRows = await base()
        .select('u.module', 'module')
        .addSelect('COUNT(*)', 'calls')
        .addSelect('COALESCE(SUM(u.tokenUsed), 0)', 'tokens')
        .groupBy('u.module')
        .orderBy('calls', 'DESC')
        .getRawMany();

      const subjectRows = await base()
        .select('u.userId', 'id')
        .addSelect('COUNT(*)', 'calls')
        .addSelect('COALESCE(SUM(u.tokenUsed), 0)', 'tokens')
        .groupBy('u.userId')
        .getRawMany();

      const { bySubject, systemIds } = classifyAiSubjects(subjectRows);

      return {
        days,
        calls: Number(totalRow?.calls || 0),
        tokens: Number(totalRow?.tokens || 0),
        byModule: moduleRows.map((r) => ({
          module: r.module || '(未标注)',
          calls: Number(r.calls || 0),
          tokens: Number(r.tokens || 0),
        })),
        bySubject,
        systemIds: systemIds.slice(0, 20),
      };
    } catch {
      return { days, error: 'query_failed' };
    }
  }

  /**
   * 渠道拆解（近 N 天）：每个渠道的 uv + 关键转化事件计数。
   * 渠道来源于前端首触归因（?ch= 参数落 localStorage 后随埋点上报）。
   */
  /**
   * 一条路漏斗（PRD-08）：测评→领计划→领题→方案→交作业→评审→分享→付费 的分层转化。
   * 每层按 distinct userId 计数；付费取会员订单。
   */
  async pathFunnel(days = 30, exclude?: string[]) {
    const since = new Date(Date.now() - days * 86400000);
    const ex = this.excludedUserIds(exclude);
    const STEPS: { key: string; label: string; event?: string }[] = [
      { key: 'visit', label: '访问', event: 'page_view' },
      { key: 'assess', label: '测评完成', event: 'onboarding_assess_done' },
      { key: 'plan', label: '领计划', event: 'plan_generate_done' },
      { key: 'claim', label: '领题', event: 'mission_claim' },
      { key: 'planSubmit', label: '指挥方案', event: 'mission_plan_submit' },
      { key: 'submit', label: '交作业', event: 'mission_submit' },
      { key: 'review', label: '评审完成', event: 'review_done' },
      { key: 'share', label: '分享回流', event: 'portfolio_view' },
    ];
    const counts: Record<string, number> = {};
    for (const s of STEPS) {
      try {
        const qb = this.eventLogModel
          .createQueryBuilder('e')
          .select('COUNT(DISTINCT e.userId)', 'c')
          .where('e.event = :ev', { ev: s.event })
          .andWhere('e.createTime >= :since', { since });
        if (ex.length) qb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
        const row = await qb.getRawOne();
        counts[s.key] = Number(row?.c || 0);
      } catch {
        counts[s.key] = 0;
      }
    }
    // 付费（会员订单）
    let paid = 0;
    try {
      const byType = await this.paidOrders(since, undefined, exclude);
      paid = byType.member?.count || 0;
    } catch {
      /* ignore */
    }

    const rate = (a: number, b: number) => (b > 0 ? Number(((a / b) * 100).toFixed(2)) : null);
    const steps = STEPS.map((s) => ({ key: s.key, label: s.label, count: counts[s.key] }));
    steps.push({ key: 'paid', label: '付费', count: paid });
    // 相邻转化率
    const withRates = steps.map((s, i) => ({
      ...s,
      rateFromPrev: i === 0 ? null : rate(s.count, steps[i - 1].count),
    }));
    return { days, steps: withRates };
  }

  async channels(days = 30, exclude?: string[]) {
    const since = new Date(Date.now() - days * 86400000);
    const ex = this.excludedUserIds(exclude);
    const CONVERSION_EVENTS = [
      'group_hint_click',
      'group_qr_view',
      'wechat_qr_view',
      'pay_flow_start',
      'pay_qr_show',
      'pay_done_click',
      'member_purchase',
      'signup_success',
    ];
    try {
      const uvQb = this.eventLogModel
        .createQueryBuilder('e')
        .select("COALESCE(e.channel, '(未标记)')", 'channel')
        .addSelect('COUNT(DISTINCT e.userId)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .groupBy("COALESCE(e.channel, '(未标记)')")
        .orderBy('uv', 'DESC');
      if (ex.length) uvQb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      const uvRows = await uvQb.getRawMany();

      const convQb = this.eventLogModel
        .createQueryBuilder('e')
        .select("COALESCE(e.channel, '(未标记)')", 'channel')
        .addSelect('e.event', 'event')
        .addSelect('COUNT(*)', 'count')
        .where('e.event IN (:...events)', { events: CONVERSION_EVENTS })
        .andWhere('e.createTime >= :since', { since })
        .groupBy("COALESCE(e.channel, '(未标记)')")
        .addGroupBy('e.event');
      if (ex.length) convQb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      const convRows = await convQb.getRawMany();

      const map: Record<string, any> = {};
      for (const r of uvRows) {
        map[r.channel] = { channel: r.channel, uv: Number(r.uv), events: {} };
      }
      for (const r of convRows) {
        map[r.channel] = map[r.channel] || { channel: r.channel, uv: 0, events: {} };
        map[r.channel].events[r.event] = Number(r.count);
      }
      return { days, conversionEvents: CONVERSION_EVENTS, list: Object.values(map) };
    } catch {
      return { days, conversionEvents: CONVERSION_EVENTS, list: [] };
    }
  }

  /** 日趋势（近 N 天）：uv + 当日已支付金额，给折线图用 */
  async daily(days = 30, exclude?: string[]) {
    const since = new Date(Date.now() - days * 86400000);
    const ex = this.excludedUserIds(exclude);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`;

    const byDate: Record<
      string,
      { date: string; uv: number; uvByIp: number; revenue: number }
    > = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = fmt(new Date(Date.now() - i * 86400000));
      byDate[d] = { date: d, uv: 0, uvByIp: 0, revenue: 0 };
    }

    try {
      const uvQb = this.eventLogModel
        .createQueryBuilder('e')
        .select('DATE(e.createTime)', 'date')
        .addSelect('COUNT(DISTINCT e.userId)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .groupBy('DATE(e.createTime)');
      if (ex.length) uvQb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      const uvRows = await uvQb.getRawMany();
      for (const r of uvRows) {
        const d = fmt(new Date(r.date));
        if (byDate[d]) byDate[d].uv = Number(r.uv);
      }
    } catch {
      /* ignore */
    }

    // 日趋势也要按 IP 出一条（同 funnel.countByIp 的理由）。只补 uv 不补这里，
    // manager 的曲线会继续画每天 1~2，而漏斗写着一周 27——同一块看板两个数打架，
    // 比只有一个错数更糟。
    try {
      const ipQb = this.eventLogModel
        .createQueryBuilder('e')
        .select('DATE(e.createTime)', 'date')
        .addSelect('COUNT(DISTINCT e.ip)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .andWhere("e.ip IS NOT NULL AND e.ip <> ''")
        .groupBy('DATE(e.createTime)');
      if (ex.length) ipQb.andWhere('(e.userId IS NULL OR e.userId NOT IN (:...ex))', { ex });
      for (const r of await ipQb.getRawMany()) {
        const d = fmt(new Date(r.date));
        if (byDate[d]) byDate[d].uvByIp = Number(r.uv);
      }
    } catch {
      /* ignore */
    }

    try {
      const revQb = this.orderModel
        .createQueryBuilder('o')
        .select('DATE(o.payTime)', 'date')
        .addSelect('SUM(o.amount)', 'amount')
        .where("o.status = 'paid'")
        .andWhere('o.payTime >= :since', { since })
        .groupBy('DATE(o.payTime)');
      if (ex.length) revQb.andWhere('o.userId NOT IN (:...ex)', { ex });
      const revRows = await revQb.getRawMany();
      const bookQb = this.bookOrderModel
        .createQueryBuilder('b')
        .select('DATE(b.payTime)', 'date')
        .addSelect('SUM(b.amount)', 'amount')
        .where("b.status = 'paid'")
        .andWhere('b.payTime >= :since', { since })
        .groupBy('DATE(b.payTime)');
      if (ex.length) bookQb.andWhere('b.userId NOT IN (:...ex)', { ex });
      const bookRows = await bookQb.getRawMany();
      for (const r of [...revRows, ...bookRows]) {
        const d = fmt(new Date(r.date));
        if (byDate[d]) byDate[d].revenue += Number(r.amount || 0);
      }
    } catch {
      /* ignore */
    }

    return { days, list: Object.values(byDate) };
  }

  /** 手动指标：按日期+指标名 upsert */
  async upsertStat(p: { statDate: string; metric: string; value: number; note?: string }) {
    if (!p.statDate || !p.metric || p.value == null) {
      return { success: false, message: 'statDate / metric / value 必填' };
    }
    const exist = await this.growthStatModel.findOne({
      where: { statDate: p.statDate, metric: p.metric },
    });
    if (exist) {
      await this.growthStatModel.update(exist.id, { value: p.value, note: p.note ?? exist.note });
      return { success: true, message: '已更新' };
    }
    await this.growthStatModel.save(
      this.growthStatModel.create({
        statDate: p.statDate,
        metric: p.metric,
        value: p.value,
        note: p.note,
      })
    );
    return { success: true, message: '已录入' };
  }

  /** 手动指标序列（复盘页表格/趋势用） */
  async listStats(p: { metric?: string; days?: number }) {
    const qb = this.growthStatModel.createQueryBuilder('s');
    if (p.metric) qb.andWhere('s.metric = :metric', { metric: p.metric });
    if (p.days) {
      const since = new Date(Date.now() - p.days * 86400000);
      const sinceStr = since.toISOString().slice(0, 10);
      qb.andWhere('s.statDate >= :sinceStr', { sinceStr });
    }
    const list = await qb.orderBy('s.statDate', 'DESC').addOrderBy('s.metric', 'ASC').take(200).getMany();
    return { list };
  }

  async deleteStat(id: number) {
    await this.growthStatModel.delete(id);
    return { success: true };
  }

  /** 复盘记录 CRUD */
  async saveReview(p: { id?: number; period: string; title: string; content: string; status?: string }) {
    if (!p.period || !p.title || !p.content) {
      return { success: false, message: 'period / title / content 必填' };
    }
    if (p.id) {
      await this.growthReviewModel.update(p.id, {
        period: p.period,
        title: p.title,
        content: p.content,
        status: p.status || 'done',
      });
      return { success: true, message: '已更新' };
    }
    const saved = await this.growthReviewModel.save(
      this.growthReviewModel.create({
        period: p.period,
        title: p.title,
        content: p.content,
        status: p.status || 'done',
      })
    );
    return { success: true, data: saved, message: '已保存' };
  }

  async listReviews(p: { page?: number; pageSize?: number }) {
    const page = p.page || 1;
    const pageSize = p.pageSize || 10;
    const [list, total] = await this.growthReviewModel.findAndCount({
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { list, total };
  }

  async deleteReview(id: number) {
    await this.growthReviewModel.delete(id);
    return { success: true };
  }
}
