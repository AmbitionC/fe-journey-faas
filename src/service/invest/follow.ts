import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { beijingDay } from '../../common/signupSite';
import {
  CashFlow,
  ETF_NAME,
  ExecRow,
  KIND_CN,
  LEG_ETF,
  LEG_ORDER,
  N_LEGS,
  PlanSignal,
  dayPlan,
  xirr,
  tradeFee,
  execStats,
  navSeries,
  nextCheckDates,
  portfolioState,
} from './followCalc';

/**
 * 跟车（2026-11-02 owner「主打服务就是买会员跟这个策略，收操作的提醒」）。
 *
 * 真源分工：规则与信号由 invest-model `broad_engine` 每日重算写 `broad_signal`；执行日收盘后
 * Python 端按用户档案（`user_follow_portfolio`：一个总资金、一个现金池）自动记账 `user_follow_exec`
 * （bench_*＝完美跟车值，shares/amount＝用户实际值）。分配规则：先卖后买，买入按现金池÷4 计量（与 followCalc.dayPlan 同）。
 * 本服务只做：档案读写（会员才可开启）、今日信号按用户现金/持仓的换算预览、净值/执行率汇总、
 * 记账行的用户修改。**不重放任何路径、不改任何规则参数**。
 *
 * 文案契约：不出现内部编号/参数名；数字全部来自库表；回测≠承诺的提示由前端同屏呈现。
 */
/** 「首个信号免费看全」上线日：此前已注册的老用户也从这天起各有一次体验。 */
export const TRIAL_LAUNCH = '20261105';

/** 北京时间当前小时 */
function bjHour(now = Date.now()): number {
  return new Date(now + 8 * 3600 * 1000).getUTCHours();
}

/** 执行日收盘（北京 15:00）是否已过；没有执行日（今天没信号）视为已过。 */
export function execPassed(execDate: string | null | undefined, now = Date.now()): boolean {
  if (!execDate) return true;
  const today = beijingDay(now);
  if (execDate < today) return true;
  return execDate === today && bjHour(now) >= 15;
}

/** 非会员可见历史的分界：exec_date 严格小于它的信号已公开（今天 15:00 后今天也算）。 */
export function publicCutoff(now = Date.now()): string {
  const today = beijingDay(now);
  if (bjHour(now) < 15) return today;
  return beijingDay(now + 24 * 3600 * 1000);
}

@Provide()
export class InvestFollowService {
  @Inject()
  db: InvestDbService;

  /** 总资金下限：现金池÷4×20% 的一笔至少要买得起一手（科创50ETF 约 1.3 元/份 ⟹ 100 份 ≈ 130 元） */
  static readonly MIN_PRINCIPAL = 10000;
  static readonly MAX_PRINCIPAL = 1e9;
  /** 用户未填佣金时的默认档（行业默认万3、最低 5 元；与 invest-model 费后统计同假设）。 */
  static readonly DEFAULT_FEE_RATE = 0.0003;
  static readonly DEFAULT_MIN_FEE = 5;
  static readonly MAX_FEE_RATE = 0.003;
  static readonly MAX_MIN_FEE = 50;

  /** 四腿「费前 / 费后」对照与具体标的信息（broad_strategy_stats，Python 每日写；无表返回 []）。 */
  async strategyStats() {
    try {
      const rows = await this.db.q(
        'SELECT leg, principal, etf, start, as_of, cum, cum_published, cum_net, bh_cum, fees, nb, ns, ' +
          'fee_rate, min_fee, expense, instrument FROM broad_strategy_stats ORDER BY leg, principal'
      );
      return rows.map((r: any) => {
        let instrument: any = null;
        try {
          instrument = r.instrument ? JSON.parse(String(r.instrument)) : null;
        } catch {
          instrument = null;
        }
        return {
          leg: String(r.leg),
          principal: Number(r.principal),
          etf: r.etf == null ? null : String(r.etf),
          start: r.start == null ? null : String(r.start),
          as_of: r.as_of == null ? null : String(r.as_of),
          cum: r.cum == null ? null : Number(r.cum),
          cum_published:
            r.cum_published == null ? null : Number(r.cum_published),
          cum_net: r.cum_net == null ? null : Number(r.cum_net),
          bh_cum: r.bh_cum == null ? null : Number(r.bh_cum),
          fees: r.fees == null ? null : Number(r.fees),
          nb: r.nb == null ? null : Number(r.nb),
          ns: r.ns == null ? null : Number(r.ns),
          fee_rate: r.fee_rate == null ? null : Number(r.fee_rate),
          min_fee: r.min_fee == null ? null : Number(r.min_fee),
          expense: r.expense == null ? null : Number(r.expense),
          instrument,
        };
      });
    } catch {
      return [];
    }
  }

  /** 市场级：决策日、四腿位置、当日信号、执行日、下一个检查日。登录即可读。 */
  async market() {
    let date: string | null = null;
    let legs: any[] = [];
    try {
      const last = await this.db.one(
        'SELECT MAX(trade_date) d FROM broad_leg_state'
      );
      date = last?.d ? String(last.d) : null;
      if (date) {
        legs = await this.db.q(
          'SELECT trade_date, leg, etf, close, `median`, buy_line, sell_line, state, fear, data_date ' +
            'FROM broad_leg_state WHERE trade_date = ? ORDER BY leg',
          [date]
        );
      }
    } catch {
      legs = [];
    }
    // 判定日＝状态表与信号表两者较新的那一天。信号表只有「有信号的日子」才有行，不能拿它的
    // MAX 当判定日：没信号的日子一多，页面就会一直把最后一次信号当「今天的动作」
    // （2026-11-04 实测：11-02/11-03 无信号，页面仍显示 10-30 的两条、「11-02 收盘前完成」）。
    // 仍兼顾同一班次「信号表先写、状态表后写」的间隙：信号表更新时以它为准。
    let today: any[] = [];
    let sigDate: string | null = null;
    try {
      const last = await this.db.one(
        'SELECT MAX(signal_date) d FROM broad_signal'
      );
      sigDate = last?.d ? String(last.d) : null;
    } catch {
      sigDate = null;
    }
    const base =
      [date, sigDate]
        .filter((d): d is string => !!d)
        .sort()
        .pop() || null;
    try {
      if (base) {
        today = await this.db.q(
          'SELECT signal_date, leg, kind, seq, exec_date, etf, side, frac, why, close, fear, ref_line, ' +
            'engine_fired FROM broad_signal WHERE signal_date = ? ORDER BY leg, seq',
          [base]
        );
      }
    } catch {
      today = [];
    }
    // 每腿最近一次「真触发」的买入信号：同一轮恐慌只买一次、阶梯档位不重发，加入在它之后的人不会再收到这一笔
    const lastBuy: Record<string, any> = {};
    try {
      const rows = await this.db.q(
        "SELECT leg, kind, signal_date, exec_date FROM broad_signal WHERE side = 'buy' AND engine_fired = 1 " +
          'ORDER BY signal_date DESC LIMIT 400'
      );
      for (const r of rows) {
        const leg = String(r.leg);
        if (!lastBuy[leg]) {
          lastBuy[leg] = {
            signal_date: String(r.signal_date),
            exec_date: r.exec_date == null ? null : String(r.exec_date),
            kind: String(r.kind),
            kind_cn: KIND_CN[String(r.kind)] || String(r.kind),
          };
        }
      }
    } catch {
      /* 无表时不显示 */
    }
    let openDays: string[] = [];
    try {
      const rows = await this.db.q(
        'SELECT cal_date FROM trade_calendar WHERE cal_date >= ? AND is_open = 1 ORDER BY cal_date LIMIT 80',
        [base || beijingDay()]
      );
      openDays = rows.map((r: any) => String(r.cal_date));
    } catch {
      openDays = [];
    }
    // 执行日只在有信号时才有意义；没信号就不给（前端据此不显示「X 收盘前完成」）
    const execDate = today[0]?.exec_date ? String(today[0].exec_date) : null;
    const check = base
      ? nextCheckDates(openDays, base)
      : { weekEnd: null, monthEnd: null };
    const order = (l: string) => {
      const i = LEG_ORDER.indexOf(l);
      return i < 0 ? 99 : i;
    };
    legs = legs
      .map((r: any) => ({
        leg: String(r.leg),
        etf: r.etf ? String(r.etf) : LEG_ETF[String(r.leg)] || null,
        etf_name:
          ETF_NAME[String(r.etf || LEG_ETF[String(r.leg)] || '')] || null,
        close: r.close == null ? null : Number(r.close),
        median: r.median == null ? null : Number(r.median),
        buy_line: r.buy_line == null ? null : Number(r.buy_line),
        sell_line: r.sell_line == null ? null : Number(r.sell_line),
        state: r.state == null ? null : String(r.state),
        fear: r.fear == null ? null : Number(r.fear),
        data_date: r.data_date == null ? null : String(r.data_date),
      }))
      .sort((a, b) => order(a.leg) - order(b.leg));
    return {
      date: base,
      state_date: date,
      signal_date: sigDate,
      today_bj: beijingDay(),
      exec_date: execDate,
      next_check: { week_end: check.weekEnd, month_end: check.monthEnd },
      legs,
      today: today.map((r: any) => this.sigOut(r)),
      last_buy: lastBuy,
      stats: await this.strategyStats(),
    };
  }

  private sigOut(r: any) {
    return {
      signal_date: String(r.signal_date),
      leg: String(r.leg),
      kind: String(r.kind),
      kind_cn: KIND_CN[String(r.kind)] || String(r.kind),
      seq: r.seq == null ? 0 : Number(r.seq),
      exec_date: r.exec_date == null ? null : String(r.exec_date),
      etf: String(r.etf || LEG_ETF[String(r.leg)] || ''),
      etf_name:
        ETF_NAME[String(r.etf || LEG_ETF[String(r.leg)] || '')] ||
        String(r.leg),
      side: String(r.side),
      frac: Number(r.frac),
      why: r.why == null ? '' : String(r.why),
      close: r.close == null ? null : Number(r.close),
      fear: r.fear == null ? null : Number(r.fear),
      ref_line: r.ref_line == null ? null : Number(r.ref_line),
      engine_fired: r.engine_fired == null ? null : Number(r.engine_fired),
    };
  }

  /** 非会员看到的信号：只有方向，不带比例与金额（比例按规则表可查，但时效与换算是会员权益）。 */
  private sigPublic(s: ReturnType<InvestFollowService['sigOut']>) {
    return {
      signal_date: s.signal_date,
      leg: s.leg,
      etf_name: s.etf_name,
      side: s.side,
      kind_cn: s.kind_cn,
      exec_date: s.exec_date,
    };
  }

  /** 非会员在执行日收盘前看到的信号：只知道今天有动作、几点前完成，不知道哪个指数、买还是卖。 */
  private sigTeaser(s: ReturnType<InvestFollowService['sigOut']>) {
    return { signal_date: s.signal_date, exec_date: s.exec_date };
  }

  /** 档案（一个总资金、一个现金池）；无表/无行返回 null。 */
  private async readPortfolio(userId: string) {
    try {
      const p = await this.db.one(
        'SELECT principal, start_date, status, fee_rate, min_fee, member_until, updated_at ' +
          'FROM user_follow_portfolio WHERE user_id = ?',
        [userId]
      );
      if (!p) return null;
      return {
        principal: Number(p.principal) || 0,
        start_date: String(p.start_date || ''),
        status: String(p.status || 'active'),
        fee_rate:
          p.fee_rate == null
            ? InvestFollowService.DEFAULT_FEE_RATE
            : Number(p.fee_rate),
        min_fee:
          p.min_fee == null
            ? InvestFollowService.DEFAULT_MIN_FEE
            : Number(p.min_fee),
      };
    } catch {
      return null;
    }
  }

  private async readExec(userId: string): Promise<ExecRow[]> {
    try {
      return await this.db.q(
        'SELECT id, leg, signal_date, kind, exec_date, etf, side, frac, price, bench_shares, bench_amount, ' +
          'bench_fee, shares, amount, fee, status, note, updated_at FROM user_follow_exec WHERE user_id = ? ' +
          'ORDER BY exec_date, signal_date, id',
        [userId]
      );
    } catch {
      return [];
    }
  }

  private async readFlows(userId: string): Promise<CashFlow[]> {
    try {
      const rows: any[] = await this.db.q(
        'SELECT id, flow_date, amount, note, created_at FROM user_follow_cashflow WHERE user_id = ? ' +
          'ORDER BY flow_date, id',
        [userId]
      );
      return rows.map(f => ({
        id: Number(f.id),
        flow_date: String(f.flow_date),
        amount: Number(f.amount) || 0,
        note: f.note == null ? '' : String(f.note),
      }));
    } catch {
      return [];
    }
  }

  /**
   * 跟车页一次出全屏。isMember 由路由按登录态判定（admin 视为会员）；非会员只给市场级信息
   * 与「今天哪条腿有动作」，不给比例/金额/账本。memberUntil 会回写档案，供邮件分发器兜底判会员。
   *
   * 会员：一个总资金 → 一个现金池 → 四个指数各自的份额。今日换算按 dayPlan（先卖后买、买入按现金池÷4 计量），
   * 净值＝现金池 + Σ 份额×最新收盘；单位净值份额法、资金加权收益 XIRR。
   */
  async overview(userId: string, isMember: boolean, memberUntil: Date | null) {
    const market = await this.market();
    if (!isMember) {
      // 首个信号免费看全（2026-11-05 owner 批「会员分层方案」）：每位用户遇到的第一个信号日，
      // 在执行日收盘前按会员口径给全（比例 + 按他填的总资金换算），之后的信号日只给「今天有 N 个动作」，
      // 执行日收盘后明细对所有人公开（规则与历史始终公开，收费的是时效与换算）。
      const trialDate = await this.trialSignalDate(userId);
      const todayDate = market.today[0]?.signal_date || null;
      const execOpen = !execPassed(market.exec_date);
      if (trialDate && todayDate === trialDate && execOpen) {
        const full = await this.memberOverview(userId, null, market);
        return { ...full, trial: true, trial_signal_date: trialDate };
      }
      const prof = await this.readPortfolio(userId);
      return {
        member: false,
        trial: false,
        // 还没用掉的首个信号体验：下一个信号日免费看全
        trial_pending: !trialDate,
        market: {
          ...market,
          today: execOpen
            ? market.today.map(s => this.sigTeaser(s))
            : market.today.map(s => this.sigPublic(s)),
          today_locked: execOpen && market.today.length > 0,
        },
        profile: prof
          ? {
              principal: prof.principal,
              start_date: prof.start_date,
              status: prof.status,
              fee_rate: prof.fee_rate,
              min_fee: prof.min_fee,
            }
          : null,
        legs: [],
        flows: [],
        curve: [],
        totals: null,
      };
    }
    return this.memberOverview(userId, memberUntil, market);
  }

  /**
   * 该用户的「首个信号体验日」：自他第一次登录访问投资站（user_site_activity）与方案上线日两者较晚的那天起，
   * 执行日不早于那天的第一个信号日。还没出信号返回 null（= 体验还没用掉）。读失败按「无体验」处理，不放大权限。
   */
  async trialSignalDate(userId: string): Promise<string | null> {
    try {
      const first = await this.db.one(
        'SELECT MIN(day) d FROM user_site_activity WHERE user_id = ?',
        [userId]
      );
      const firstDay = first?.d ? String(first.d) : beijingDay();
      const anchor = firstDay > TRIAL_LAUNCH ? firstDay : TRIAL_LAUNCH;
      const row = await this.db.one(
        'SELECT MIN(signal_date) d FROM broad_signal WHERE exec_date >= ?',
        [anchor]
      );
      return row?.d ? String(row.d) : null;
    } catch {
      return 'unavailable';
    }
  }

  private async memberOverview(
    userId: string,
    memberUntil: Date | null,
    market: Awaited<ReturnType<InvestFollowService['market']>>
  ) {
    const prof = await this.readPortfolio(userId);
    if (prof && memberUntil) {
      try {
        await this.db.exec(
          'UPDATE user_follow_portfolio SET member_until = ? WHERE user_id = ?',
          [memberUntil, userId]
        );
      } catch {
        // 兜底字段写失败不影响页面
      }
    }
    // 估值与换算用「今天（北京）之前最新的 ETF 收盘」，不用判定日：判定日是信号口径，
    // 收盘价表可能已经比它新（周更/补数场景），估值永远取最新可得的那一天。
    const todayBase = beijingDay();
    if (!prof) {
      return {
        member: true,
        member_until: memberUntil ? memberUntil.toISOString() : null,
        market,
        profile: null,
        legs: LEG_ORDER.map(leg => ({
          leg,
          etf: LEG_ETF[leg],
          etf_name: ETF_NAME[LEG_ETF[leg]],
          market: market.legs.find(l => l.leg === leg) || null,
        })),
        flows: [],
        curve: [],
        totals: null,
      };
    }
    const {
      principal,
      start_date: startDate,
      status,
      fee_rate: feeRate,
      min_fee: minFee,
    } = prof;
    const execAll = await this.readExec(userId);
    const flows = await this.readFlows(userId);
    const netIn =
      Math.round((principal + flows.reduce((s, f) => s + f.amount, 0)) * 100) /
      100;
    const actual = portfolioState(principal, execAll, false, flows);
    const bench = portfolioState(principal, execAll, true, flows);
    // 各指数自起步日起的收盘序列（曲线用）与最新价（换算与估值用）
    const closesByLeg: Record<string, { date: string; close: number }[]> = {};
    const priceByLeg: Record<string, { close: number; date: string } | null> =
      {};
    for (const leg of LEG_ORDER) {
      const etf = LEG_ETF[leg];
      let closes: { date: string; close: number }[] = [];
      let price: { close: number; date: string } | null = null;
      try {
        const q = await this.db.q(
          'SELECT trade_date, close FROM stock_daily WHERE code = ? AND trade_date >= ? AND trade_date <= ? ' +
            'ORDER BY trade_date',
          [etf, startDate, todayBase]
        );
        closes = q
          .filter((r: any) => r.close != null && Number(r.close) > 0)
          .map((r: any) => ({
            date: String(r.trade_date),
            close: Number(r.close),
          }));
        if (closes.length) {
          price = {
            close: closes[closes.length - 1].close,
            date: closes[closes.length - 1].date,
          };
        } else {
          const one = await this.db.one(
            'SELECT trade_date, close FROM stock_daily WHERE code = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1',
            [etf, todayBase]
          );
          if (one && one.close != null)
            price = { close: Number(one.close), date: String(one.trade_date) };
        }
      } catch {
        price = null;
      }
      closesByLeg[leg] = closes;
      priceByLeg[leg] = price;
    }
    const pxOf = (leg: string) => priceByLeg[leg]?.close ?? null;
    // 今日待执行：未记账、执行日不早于起步日、档案在跟（暂停不出提醒）
    const recorded = new Set(
      execAll.map(r => `${r.leg}|${r.signal_date}|${r.kind}`)
    );
    const unrecorded = market.today.filter(
      s => !recorded.has(`${s.leg}|${s.signal_date}|${s.kind}`)
    );
    const todo: PlanSignal[] = unrecorded
      .filter(s => status === 'active' && (s.exec_date || '') >= startDate)
      .map(s => ({ ...s }));
    // 今天有信号但不在你的账本里的两种情况，也要给出一句话，否则页面只见「有动作」不见金额
    // （2026-11-04 实测：11-03 起步的人看到 10-30 的信号却没有任何换算与解释）
    const fmtDay = (d: string) =>
      d && d.length === 8
        ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
        : d;
    const mine = new Set(
      todo.map((t: any) => `${t.leg}|${t.signal_date}|${t.kind}`)
    );
    const notMine = unrecorded
      .filter(s => !mine.has(`${s.leg}|${s.signal_date}|${s.kind}`))
      .map(s => {
        const name = `${
          ETF_NAME[String(s.etf || LEG_ETF[s.leg] || '')] || s.leg
        }（${String(s.etf || LEG_ETF[s.leg] || '').split('.')[0]}）`;
        const beforeStart = (s.exec_date || '') < startDate;
        return {
          ...(s as any),
          shares: 0,
          amount: 0,
          fee: 0,
          skipped: true,
          reason: beforeStart ? '起步前触发' : '已暂停',
          text: beforeStart
            ? `${name}：这笔在你 ${fmtDay(
                startDate
              )} 起步之前触发（执行日 ${fmtDay(
                String(s.exec_date || '')
              )}），不补发，不在你的账本里`
            : `${name}：跟车已暂停，这笔不换算、不记账`,
          cashAfter: actual.cash,
          unitsAfter: actual.units[s.leg] || 0,
          price_basis: null,
        };
      });
    const plan = dayPlan(
      actual.cash,
      actual.units,
      todo,
      pxOf,
      feeRate,
      minFee
    );
    const adviceOf = (leg: string) => [
      ...plan.items
        .filter(i => i.sig.leg === leg)
        .map(i => ({
          ...(i.sig as any),
          shares: i.shares,
          amount: i.amount,
          fee: i.fee,
          skipped: i.skipped,
          reason: i.reason,
          text: i.text,
          cashAfter: i.cashAfter,
          unitsAfter: i.unitsAfter,
          price_basis: priceByLeg[leg],
        })),
      ...notMine.filter(i => i.leg === leg),
    ];
    const hasAllPrices = LEG_ORDER.every(
      leg =>
        pxOf(leg) != null ||
        ((actual.units[leg] || 0) === 0 && (bench.units[leg] || 0) === 0)
    );
    const valueOf = (st: { cash: number; units: Record<string, number> }) =>
      hasAllPrices
        ? Math.round(
            (st.cash +
              LEG_ORDER.reduce(
                (s, leg) => s + (st.units[leg] || 0) * (pxOf(leg) || 0),
                0
              )) *
              100
          ) / 100
        : null;
    const nav = valueOf(actual);
    const benchNav = valueOf(bench);
    const legs = LEG_ORDER.map(leg => {
      const etf = LEG_ETF[leg];
      const rows = execAll.filter(r => String(r.leg) === leg);
      const px = pxOf(leg);
      const units = actual.units[leg] || 0;
      const bunits = bench.units[leg] || 0;
      const value = px == null ? null : Math.round(units * px * 100) / 100;
      return {
        leg,
        etf,
        etf_name: ETF_NAME[etf],
        market: market.legs.find(l => l.leg === leg) || null,
        price: priceByLeg[leg],
        units,
        bench_units: bunits,
        value,
        bench_value: px == null ? null : Math.round(bunits * px * 100) / 100,
        share:
          value == null || nav == null || nav <= 0
            ? null
            : Math.round((value / nav) * 1000) / 10,
        stats: execStats(rows),
        advice: adviceOf(leg),
        recent: rows
          .slice(-20)
          .reverse()
          .map(r => this.execOut(r)),
      };
    });
    const series = navSeries(principal, execAll, closesByLeg, flows);
    const latestPriceDay =
      LEG_ORDER.map(l => priceByLeg[l]?.date || '')
        .filter(Boolean)
        .sort()
        .pop() || null;
    const lastDate = series.length
      ? series[series.length - 1].date
      : latestPriceDay || market.date || todayBase;
    const allFlows: { date: string; amount: number }[] = [
      { date: startDate, amount: -principal },
    ];
    for (const f of flows)
      allFlows.push({ date: f.flow_date, amount: -f.amount });
    const mwr =
      nav == null
        ? null
        : xirr(
            [...allFlows, { date: lastDate, amount: nav }].sort((a, b) =>
              a.date.localeCompare(b.date)
            )
          );
    // 你今天真要动手的笔数：按规则跳过的（没有持仓 / 不足一手）、起步前的、暂停的都不算
    const actions = plan.items.filter(i => !i.skipped);
    const totals = {
      principal,
      net_in: netIn,
      pnl: nav == null ? null : Math.round((nav - netIn) * 100) / 100,
      unit_nav: series.length ? series[series.length - 1].unit : null,
      bench_unit_nav: series.length
        ? series[series.length - 1].bench_unit
        : null,
      mwr,
      nav,
      bench_nav: benchNav,
      bench_pnl:
        benchNav == null ? null : Math.round((benchNav - netIn) * 100) / 100,
      cash: actual.cash,
      bench_cash: bench.cash,
      cash_share:
        nav == null || nav <= 0
          ? null
          : Math.round((actual.cash / nav) * 1000) / 10,
      /** 买入前各指数当天的计量额度：现金池 ÷ 4 */
      quarter: Math.round((Math.max(actual.cash, 0) / N_LEGS) * 100) / 100,
      actions_today: actions.length,
      stats: execStats(execAll),
      as_of: lastDate,
    };
    return {
      member: true,
      member_until: memberUntil ? memberUntil.toISOString() : null,
      market,
      profile: {
        principal,
        start_date: startDate,
        status,
        fee_rate: feeRate,
        min_fee: minFee,
      },
      legs,
      flows,
      curve: series,
      totals,
    };
  }

  /**
   * 资金进出（会员，只写自己的，组合级）。add：amount>0 追加 / <0 取出；flow_date 默认今天，不早于起步日
   * 与最后一笔记账日（不改写历史）、不晚于今天；取出不超过「你的现金池」与「基准现金池」二者较小值
   * （取出只动现金，不自动卖出）。remove：其后已有记账的流水不可删（那些笔的金额按它算过），
   * 请录一笔反向流水。
   */
  async cashflow(userId: string, body: any) {
    const action = String(body?.action || 'add');
    const today = beijingDay();
    const now = new Date();
    const cur = await this.readPortfolio(userId);
    if (!cur) throw new Error('尚未开启跟车');
    const rows = await this.readExec(userId);
    const lastExec = rows.reduce(
      (m, r) => (String(r.exec_date) > m ? String(r.exec_date) : m),
      ''
    );
    if (action === 'remove') {
      const id = Number(body?.id);
      if (!Number.isFinite(id)) throw new Error('缺少流水编号');
      const row = await this.db.one(
        'SELECT id, flow_date FROM user_follow_cashflow WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (!row) throw new Error('流水不存在');
      if (lastExec && String(row.flow_date) < lastExec)
        throw new Error(
          '这笔流水之后已经有记账，不能删除；要撤销请录一笔反向的追加或取出'
        );
      await this.db.exec(
        'DELETE FROM user_follow_cashflow WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      return { ok: true, removed: id };
    }
    const amount = Math.round(Number(body?.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount === 0)
      throw new Error('金额不能为 0');
    if (Math.abs(amount) > InvestFollowService.MAX_PRINCIPAL)
      throw new Error('金额超出可填范围');
    let day = String(body?.flow_date || today)
      .replace(/-/g, '')
      .slice(0, 8);
    if (!/^\d{8}$/.test(day)) throw new Error('日期格式应为 YYYYMMDD');
    if (day > today) throw new Error('日期不能晚于今天');
    const start = String(cur.start_date || '');
    if (day < start) day = start;
    if (lastExec && day < lastExec)
      throw new Error(`日期不能早于最后一笔记账日 ${lastExec}（历史不改写）`);
    const fl = await this.readFlows(userId);
    if (amount < 0) {
      const a = portfolioState(cur.principal, rows, false, fl);
      const b = portfolioState(cur.principal, rows, true, fl);
      const cap = Math.floor(Math.min(a.cash, b.cash) * 100) / 100;
      if (-amount > cap + 1e-9)
        throw new Error(
          `最多可取出 ${cap.toLocaleString(
            'zh-CN'
          )} 元（你的现金 ${a.cash.toLocaleString(
            'zh-CN'
          )} 元、基准现金 ${b.cash.toLocaleString(
            'zh-CN'
          )} 元，取小）；取出只动现金，不会自动卖出`
        );
    }
    const note = String(body?.note || '').slice(0, 64);
    await this.db.exec(
      'INSERT INTO user_follow_cashflow (user_id, leg, flow_date, amount, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, '*', day, amount, note, now]
    );
    return {
      ok: true,
      flow_date: day,
      amount,
      effective: '从下一笔买入信号起按新的现金池换算',
    };
  }

  private execOut(r: ExecRow & { updated_at?: any }) {
    return {
      id: r.id,
      leg: r.leg,
      signal_date: String(r.signal_date),
      kind: r.kind,
      kind_cn: KIND_CN[String(r.kind)] || String(r.kind),
      exec_date: r.exec_date == null ? null : String(r.exec_date),
      etf: r.etf,
      etf_name: ETF_NAME[String(r.etf || '')] || String(r.leg),
      side: r.side,
      frac: r.frac == null ? null : Number(r.frac),
      price: r.price == null ? null : Number(r.price),
      bench_shares: r.bench_shares == null ? null : Number(r.bench_shares),
      bench_amount: r.bench_amount == null ? null : Number(r.bench_amount),
      bench_fee: r.bench_fee == null ? 0 : Number(r.bench_fee),
      shares: r.shares == null ? null : Number(r.shares),
      amount: r.amount == null ? null : Number(r.amount),
      fee: r.fee == null ? 0 : Number(r.fee),
      status: r.status || 'auto',
      note: r.note || '',
    };
  }

  /**
   * 档案保存（会员专属，路由把关）。一个用户一份档案＝一个总资金。规则：
   *  - 总资金 ≥ 10000 元（现金池÷4×20% 才够买一手）；起步日默认今天（北京），不得早于今天（不回溯记账）；
   *  - 修改总资金或起步日会**重开账本**（删除已有记账行与资金流水），前端须提示；
   *  - action: save（新建/修改）| pause（暂停：保留记录、不再记新信号）| resume（恢复）| remove（删档案及其全部记录）。
   */
  async saveProfile(userId: string, memberUntil: Date | null, body: any) {
    const action = String(body?.action || 'save');
    const today = beijingDay();
    const now = new Date();
    if (action === 'remove') {
      await this.db.exec('DELETE FROM user_follow_exec WHERE user_id = ?', [
        userId,
      ]);
      await this.db.exec('DELETE FROM user_follow_cashflow WHERE user_id = ?', [
        userId,
      ]);
      await this.db.exec(
        'DELETE FROM user_follow_portfolio WHERE user_id = ?',
        [userId]
      );
      return { ok: true, reset: true };
    }
    const cur = await this.db.one(
      'SELECT principal, start_date, status, fee_rate, min_fee FROM user_follow_portfolio WHERE user_id = ?',
      [userId]
    );
    if (action === 'pause' || action === 'resume') {
      if (!cur) throw new Error('尚未开启跟车');
      await this.db.exec(
        'UPDATE user_follow_portfolio SET status = ?, member_until = ?, updated_at = ? WHERE user_id = ?',
        [action === 'pause' ? 'paused' : 'active', memberUntil, now, userId]
      );
      return { ok: true, status: action === 'pause' ? 'paused' : 'active' };
    }
    const principal = Math.round(Number(body?.principal) * 100) / 100;
    if (
      !Number.isFinite(principal) ||
      principal < InvestFollowService.MIN_PRINCIPAL
    )
      throw new Error(
        `总资金至少 ${InvestFollowService.MIN_PRINCIPAL.toLocaleString(
          'zh-CN'
        )} 元`
      );
    if (principal > InvestFollowService.MAX_PRINCIPAL)
      throw new Error('总资金超出可填范围');
    let start = String(body?.start_date || today)
      .replace(/-/g, '')
      .slice(0, 8);
    if (!/^\d{8}$/.test(start)) throw new Error('起步日格式应为 YYYYMMDD');
    if (start < today) start = today;
    // 佣金：未填用默认档；改佣金不重开账本（只影响之后的记账与换算）
    const feeRate =
      body?.fee_rate == null || body?.fee_rate === ''
        ? cur?.fee_rate == null
          ? InvestFollowService.DEFAULT_FEE_RATE
          : Number(cur.fee_rate)
        : Number(body.fee_rate);
    const minFee =
      body?.min_fee == null || body?.min_fee === ''
        ? cur?.min_fee == null
          ? InvestFollowService.DEFAULT_MIN_FEE
          : Number(cur.min_fee)
        : Number(body.min_fee);
    if (
      !Number.isFinite(feeRate) ||
      feeRate < 0 ||
      feeRate > InvestFollowService.MAX_FEE_RATE
    )
      throw new Error('佣金率应在 0 到 0.3% 之间（万3 填 0.0003）');
    if (
      !Number.isFinite(minFee) ||
      minFee < 0 ||
      minFee > InvestFollowService.MAX_MIN_FEE
    )
      throw new Error('最低佣金应在 0 到 50 元之间');
    let reset = false;
    if (cur) {
      const changed =
        Math.abs(Number(cur.principal) - principal) > 0.005 ||
        String(cur.start_date) !== start;
      if (changed) {
        const n = await this.db.one(
          'SELECT COUNT(*) n FROM user_follow_exec WHERE user_id = ?',
          [userId]
        );
        if (Number(n?.n || 0) > 0) {
          if (!body?.confirm_reset)
            throw new Error('修改总资金或起步日会重新开始记账，请确认');
          await this.db.exec('DELETE FROM user_follow_exec WHERE user_id = ?', [
            userId,
          ]);
          // 资金进出流水跟着账本一起归零：它们是旧本金/旧起步日下的事实，留着会算进新账本
          await this.db.exec(
            'DELETE FROM user_follow_cashflow WHERE user_id = ?',
            [userId]
          );
          reset = true;
        }
      }
      await this.db.exec(
        'UPDATE user_follow_portfolio SET principal = ?, start_date = ?, status = ?, fee_rate = ?, min_fee = ?, ' +
          'member_until = ?, updated_at = ? WHERE user_id = ?',
        [principal, start, 'active', feeRate, minFee, memberUntil, now, userId]
      );
    } else {
      await this.db.exec(
        'INSERT INTO user_follow_portfolio (user_id, principal, start_date, status, fee_rate, min_fee, ' +
          'member_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, principal, start, 'active', feeRate, minFee, memberUntil, now]
      );
    }
    return {
      ok: true,
      reset,
      principal,
      start_date: start,
      fee_rate: feeRate,
      min_fee: minFee,
    };
  }

  /** 记账行修改（只改自己的）：done＝按提醒做了；skipped＝没做；edited＝实际份额/价格不同。 */
  async updateExec(userId: string, body: any) {
    const id = Number(body?.id) || 0;
    const status = String(body?.status || '');
    if (!id) throw new Error('缺少记录编号');
    if (!['done', 'skipped', 'edited', 'auto'].includes(status))
      throw new Error('状态不合法');
    const row = await this.db.one(
      'SELECT id, leg, side, price, bench_shares, bench_amount FROM user_follow_exec WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    if (!row) throw new Error('记录不存在');
    let feeRate = InvestFollowService.DEFAULT_FEE_RATE;
    let minFee = InvestFollowService.DEFAULT_MIN_FEE;
    try {
      const prof = await this.db.one(
        'SELECT fee_rate, min_fee FROM user_follow_portfolio WHERE user_id = ?',
        [userId]
      );
      if (prof) {
        if (prof.fee_rate != null) feeRate = Number(prof.fee_rate);
        if (prof.min_fee != null) minFee = Number(prof.min_fee);
      }
    } catch {
      // 档案读不到用默认档
    }
    const note = String(body?.note || '').slice(0, 64);
    const now = new Date();
    if (status === 'edited') {
      const shares = Number(body?.shares);
      const price = Number(body?.price);
      if (
        !Number.isFinite(shares) ||
        shares < 0 ||
        Math.round(shares) !== shares
      )
        throw new Error('份额应为非负整数');
      if (!Number.isFinite(price) || !(price > 0))
        throw new Error('价格应大于 0');
      const amount = Math.round(shares * price * 100) / 100;
      // 佣金：用户可直接填实际佣金；没填按档案费率算（0 份＝没成交＝无佣金）
      const fee =
        body?.fee == null || body?.fee === ''
          ? shares > 0
            ? Math.round(tradeFee(amount, feeRate, minFee) * 100) / 100
            : 0
          : Math.max(0, Number(body.fee) || 0);
      await this.db.exec(
        'UPDATE user_follow_exec SET status = ?, shares = ?, amount = ?, fee = ?, note = ?, updated_at = ? ' +
          'WHERE id = ? AND user_id = ?',
        ['edited', shares, amount, fee, note, now, id, userId]
      );
      return { ok: true, shares, amount, fee };
    }
    if (status === 'auto') {
      // 撤销修改：回到自动值
      await this.db.exec(
        'UPDATE user_follow_exec SET status = ?, shares = bench_shares, amount = bench_amount, fee = bench_fee, ' +
          'note = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        ['auto', note, now, id, userId]
      );
      return { ok: true };
    }
    await this.db.exec(
      'UPDATE user_follow_exec SET status = ?, note = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [status, note, now, id, userId]
    );
    return { ok: true };
  }

  /** 信号流：会员全量（最近 limit 条）；非会员看执行日收盘后已公开的历史（不带比例）。 */
  async signals(isMember: boolean, limit = 60) {
    const n = Math.min(Math.max(Number(limit) || 60, 1), 500);
    try {
      if (isMember) {
        const rows = await this.db.q(
          'SELECT signal_date, leg, kind, seq, exec_date, etf, side, frac, why, close, fear, ref_line, engine_fired ' +
            'FROM broad_signal ORDER BY signal_date DESC, leg, seq LIMIT ?',
          [n]
        );
        return { member: true, rows: rows.map((r: any) => this.sigOut(r)) };
      }
      // 执行日收盘（北京 15:00）后公开；此前只有会员看得到当天明细
      const cutoff = publicCutoff();
      const rows = await this.db.q(
        'SELECT signal_date, leg, kind, seq, exec_date, etf, side, frac, why, close, fear, ref_line, engine_fired ' +
          'FROM broad_signal WHERE exec_date < ? ORDER BY signal_date DESC, leg, seq LIMIT ?',
        [cutoff, Math.min(n, 60)]
      );
      return {
        member: false,
        cutoff,
        rows: rows.map((r: any) => this.sigPublic(this.sigOut(r))),
      };
    } catch {
      return { member: isMember, rows: [] };
    }
  }
}
