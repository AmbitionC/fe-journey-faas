import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user';
import { OrderEntity } from '../../entity/order';
import { BookOrderEntity } from '../../entity/bookOrder';
import { EventLogEntity } from '../../entity/eventLog';
import { GrowthStatEntity } from '../../entity/growthStat';
import { GrowthReviewEntity } from '../../entity/growthReview';

/** 高价 SKU 的订单类型（order.type）；破冰 SKU = pdf + 书籍订单 */
const HIGH_VALUE_ORDER_TYPES = ['member', 'consult'];

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

  @InjectEntityModel(GrowthStatEntity)
  growthStatModel: Repository<GrowthStatEntity>;

  @InjectEntityModel(GrowthReviewEntity)
  growthReviewModel: Repository<GrowthReviewEntity>;

  /** 某指标最近一次录入值 */
  private async latestStat(metric: string): Promise<{ value: number; statDate: string } | null> {
    const row = await this.growthStatModel.findOne({
      where: { metric },
      order: { statDate: 'DESC' },
    });
    return row ? { value: Number(row.value), statDate: row.statDate } : null;
  }

  /** 时间段内已支付订单的数量与金额（order + book_order 合并） */
  private async paidOrders(since: Date, until?: Date) {
    const qb1 = this.orderModel
      .createQueryBuilder('o')
      .select('o.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(o.amount)', 'amount')
      .where("o.status = 'paid'")
      .andWhere('o.payTime >= :since', { since })
      .groupBy('o.type');
    if (until) qb1.andWhere('o.payTime < :until', { until });
    const orders = await qb1.getRawMany();

    const qb2 = this.bookOrderModel
      .createQueryBuilder('b')
      .select('COUNT(*)', 'count')
      .addSelect('SUM(b.amount)', 'amount')
      .where("b.status = 'paid'")
      .andWhere('b.payTime >= :since', { since });
    if (until) qb2.andWhere('b.payTime < :until', { until });
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
  async overview() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const byType = await this.paidOrders(monthStart);
    const monthRevenue = Object.values(byType).reduce((s, v) => s + v.amount, 0);
    const monthOrderCount = Object.values(byType).reduce((s, v) => s + v.count, 0);

    const [cost, groupMembers, xhsFollowers] = await Promise.all([
      this.latestStat('monthly_cost'),
      this.latestStat('group_members'),
      this.latestStat('xhs_followers'),
    ]);

    let monthNewUsers = 0;
    try {
      monthNewUsers = await this.userModel
        .createQueryBuilder('u')
        .where('u.createTime >= :since', { since: monthStart })
        .getCount();
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
  async funnel(days = 30) {
    const since = new Date(Date.now() - days * 86400000);

    let uv = 0;
    try {
      const row = await this.eventLogModel
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.userId)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .getRawOne();
      uv = Number(row?.uv || 0);
    } catch {
      /* ignore */
    }

    let signups = 0;
    try {
      signups = await this.userModel
        .createQueryBuilder('u')
        .where('u.createTime >= :since', { since })
        .getCount();
    } catch {
      /* ignore */
    }

    const byType = await this.paidOrders(since);
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
      stages: [
        { key: 'visit', label: '访问 UV', count: uv },
        { key: 'signup', label: '注册', count: signups, rateFromPrev: rate(signups, uv) },
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
   * 渠道拆解（近 N 天）：每个渠道的 uv + 关键转化事件计数。
   * 渠道来源于前端首触归因（?ch= 参数落 localStorage 后随埋点上报）。
   */
  /**
   * 一条路漏斗（PRD-08）：测评→领计划→领题→方案→交作业→评审→分享→付费 的分层转化。
   * 每层按 distinct userId 计数；付费取会员订单。
   */
  async pathFunnel(days = 30) {
    const since = new Date(Date.now() - days * 86400000);
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
        const row = await this.eventLogModel
          .createQueryBuilder('e')
          .select('COUNT(DISTINCT e.userId)', 'c')
          .where('e.event = :ev', { ev: s.event })
          .andWhere('e.createTime >= :since', { since })
          .getRawOne();
        counts[s.key] = Number(row?.c || 0);
      } catch {
        counts[s.key] = 0;
      }
    }
    // 付费（会员订单）
    let paid = 0;
    try {
      const byType = await this.paidOrders(since);
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

  async channels(days = 30) {
    const since = new Date(Date.now() - days * 86400000);
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
      const uvRows = await this.eventLogModel
        .createQueryBuilder('e')
        .select("COALESCE(e.channel, '(未标记)')", 'channel')
        .addSelect('COUNT(DISTINCT e.userId)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .groupBy("COALESCE(e.channel, '(未标记)')")
        .orderBy('uv', 'DESC')
        .getRawMany();

      const convRows = await this.eventLogModel
        .createQueryBuilder('e')
        .select("COALESCE(e.channel, '(未标记)')", 'channel')
        .addSelect('e.event', 'event')
        .addSelect('COUNT(*)', 'count')
        .where('e.event IN (:...events)', { events: CONVERSION_EVENTS })
        .andWhere('e.createTime >= :since', { since })
        .groupBy("COALESCE(e.channel, '(未标记)')")
        .addGroupBy('e.event')
        .getRawMany();

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
  async daily(days = 30) {
    const since = new Date(Date.now() - days * 86400000);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`;

    const byDate: Record<string, { date: string; uv: number; revenue: number }> = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = fmt(new Date(Date.now() - i * 86400000));
      byDate[d] = { date: d, uv: 0, revenue: 0 };
    }

    try {
      const uvRows = await this.eventLogModel
        .createQueryBuilder('e')
        .select('DATE(e.createTime)', 'date')
        .addSelect('COUNT(DISTINCT e.userId)', 'uv')
        .where("e.event = 'page_view'")
        .andWhere('e.createTime >= :since', { since })
        .groupBy('DATE(e.createTime)')
        .getRawMany();
      for (const r of uvRows) {
        const d = fmt(new Date(r.date));
        if (byDate[d]) byDate[d].uv = Number(r.uv);
      }
    } catch {
      /* ignore */
    }

    try {
      const revRows = await this.orderModel
        .createQueryBuilder('o')
        .select('DATE(o.payTime)', 'date')
        .addSelect('SUM(o.amount)', 'amount')
        .where("o.status = 'paid'")
        .andWhere('o.payTime >= :since', { since })
        .groupBy('DATE(o.payTime)')
        .getRawMany();
      const bookRows = await this.bookOrderModel
        .createQueryBuilder('b')
        .select('DATE(b.payTime)', 'date')
        .addSelect('SUM(b.amount)', 'amount')
        .where("b.status = 'paid'")
        .andWhere('b.payTime >= :since', { since })
        .groupBy('DATE(b.payTime)')
        .getRawMany();
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
