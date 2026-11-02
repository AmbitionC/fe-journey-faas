import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { beijingDay } from '../../common/signupSite';
import {
  ETF_NAME,
  ExecRow,
  KIND_CN,
  LEG_ETF,
  LEG_ORDER,
  advise,
  combineCurves,
  execStats,
  navSeries,
  nextCheckDates,
  stateFromRows,
} from './followCalc';

/**
 * 跟车（2026-11-02 owner「主打服务就是买会员跟这个策略，收操作的提醒」）。
 *
 * 真源分工：规则与信号由 invest-model `broad_engine` 每日重算写 `broad_signal`；执行日收盘后
 * Python 端按用户档案自动记账 `user_follow_exec`（bench_*＝完美跟车值，shares/amount＝用户实际值）。
 * 本服务只做：档案读写（会员才可开启）、今日信号按用户现金/持仓的换算预览、净值/执行率汇总、
 * 记账行的用户修改。**不重放任何路径、不改任何规则参数**。
 *
 * 文案契约：不出现内部编号/参数名；数字全部来自库表；回测≠承诺的提示由前端同屏呈现。
 */
@Provide()
export class InvestFollowService {
  @Inject()
  db: InvestDbService;

  static readonly MIN_PRINCIPAL = 1000;
  static readonly MAX_PRINCIPAL = 1e9;

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
    let today: any[] = [];
    let sigDate: string | null = null;
    try {
      const last = await this.db.one(
        'SELECT MAX(signal_date) d FROM broad_signal'
      );
      sigDate = last?.d ? String(last.d) : null;
      // 信号表与状态表都由同一班次写；以信号表自己的最新日为准，避免状态表先写、信号表后写时漏掉当日信号
      if (sigDate) {
        today = await this.db.q(
          'SELECT signal_date, leg, kind, seq, exec_date, etf, side, frac, why, close, fear, ref_line, ' +
            'engine_fired FROM broad_signal WHERE signal_date = ? ORDER BY leg, seq',
          [sigDate]
        );
      }
    } catch {
      today = [];
    }
    const base = sigDate || date;
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
    const execDate = today[0]?.exec_date
      ? String(today[0].exec_date)
      : openDays.find(d => d > (base || '')) || null;
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
      exec_date: execDate,
      next_check: { week_end: check.weekEnd, month_end: check.monthEnd },
      legs,
      today: today.map((r: any) => this.sigOut(r)),
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

  /**
   * 跟车页一次出全屏。isMember 由路由按登录态判定（admin 视为会员）；非会员只给市场级信息
   * 与「今天哪条腿有动作」，不给比例/金额/账本。memberUntil 会回写档案，供邮件分发器兜底判会员。
   */
  async overview(userId: string, isMember: boolean, memberUntil: Date | null) {
    const market = await this.market();
    if (!isMember) {
      return {
        member: false,
        market: { ...market, today: market.today.map(s => this.sigPublic(s)) },
        profile: null,
        legs: [],
        curve: [],
        totals: null,
      };
    }
    let prof: any[] = [];
    try {
      prof = await this.db.q(
        'SELECT leg, principal, start_date, status, member_until, updated_at FROM user_follow_profile WHERE user_id = ?',
        [userId]
      );
    } catch {
      prof = [];
    }
    if (prof.length && memberUntil) {
      try {
        await this.db.exec(
          'UPDATE user_follow_profile SET member_until = ? WHERE user_id = ?',
          [memberUntil, userId]
        );
      } catch {
        // 兜底字段写失败不影响页面
      }
    }
    const byLeg = new Map<string, any>(prof.map(p => [String(p.leg), p]));
    let execAll: ExecRow[] = [];
    if (prof.length) {
      try {
        execAll = await this.db.q(
          'SELECT id, leg, signal_date, kind, exec_date, etf, side, frac, price, bench_shares, bench_amount, ' +
            'shares, amount, status, note, updated_at FROM user_follow_exec WHERE user_id = ? ' +
            'ORDER BY exec_date, signal_date, id',
          [userId]
        );
      } catch {
        execAll = [];
      }
    }
    const todayBase = market.date || beijingDay();
    const legs: any[] = [];
    const curves: {
      principal: number;
      series: { date: string; nav: number; bench: number }[];
    }[] = [];
    for (const leg of LEG_ORDER) {
      const p = byLeg.get(leg);
      const etf = LEG_ETF[leg];
      const mkt = market.legs.find(l => l.leg === leg) || null;
      if (!p) {
        legs.push({
          leg,
          etf,
          etf_name: ETF_NAME[etf],
          enabled: false,
          market: mkt,
        });
        continue;
      }
      const principal = Number(p.principal) || 0;
      const startDate = String(p.start_date || '');
      const status = String(p.status || 'active');
      const rows = execAll.filter(r => String(r.leg) === leg);
      const actual = stateFromRows(principal, rows, false);
      const bench = stateFromRows(principal, rows, true);
      let price: { close: number; date: string } | null = null;
      let closes: { date: string; close: number }[] = [];
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
        if (closes.length)
          price = {
            close: closes[closes.length - 1].close,
            date: closes[closes.length - 1].date,
          };
        else {
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
      const px = price?.close ?? null;
      const nav =
        px == null
          ? null
          : Math.round((actual.cash + actual.units * px) * 100) / 100;
      const benchNav =
        px == null
          ? null
          : Math.round((bench.cash + bench.units * px) * 100) / 100;
      const recorded = new Set(rows.map(r => `${r.signal_date}|${r.kind}`));
      const todo = market.today
        .filter(
          s =>
            s.leg === leg &&
            status === 'active' &&
            (s.exec_date || '') >= startDate
        )
        .filter(s => !recorded.has(`${s.signal_date}|${s.kind}`));
      // 多条信号按 seq 顺序串联换算（恐慌抢买先扣现金，锚买再按剩余现金算）
      let c = actual.cash;
      let u = actual.units;
      const advice = todo.map(s => {
        const a = advise(
          { side: s.side, frac: s.frac, kind: s.kind, etf: s.etf },
          c,
          u,
          px
        );
        c = a.cashAfter;
        u = a.unitsAfter;
        return { ...s, ...a, price_basis: price };
      });
      const series = navSeries(principal, rows, closes);
      curves.push({ principal, series });
      legs.push({
        leg,
        etf,
        etf_name: ETF_NAME[etf],
        enabled: true,
        status,
        principal,
        start_date: startDate,
        market: mkt,
        price,
        cash: actual.cash,
        units: actual.units,
        nav,
        pnl: nav == null ? null : Math.round((nav - principal) * 100) / 100,
        bench: { cash: bench.cash, units: bench.units, nav: benchNav },
        stats: execStats(rows),
        advice,
        recent: rows
          .slice(-20)
          .reverse()
          .map(r => this.execOut(r)),
      });
    }
    const enabled = legs.filter(l => l.enabled);
    const totals = enabled.length
      ? {
          principal: enabled.reduce((s, l) => s + l.principal, 0),
          nav: enabled.every(l => l.nav != null)
            ? Math.round(enabled.reduce((s, l) => s + l.nav, 0) * 100) / 100
            : null,
          bench_nav: enabled.every(l => l.bench.nav != null)
            ? Math.round(enabled.reduce((s, l) => s + l.bench.nav, 0) * 100) /
              100
            : null,
          cash: Math.round(enabled.reduce((s, l) => s + l.cash, 0) * 100) / 100,
          actions_today: enabled.reduce((s, l) => s + l.advice.length, 0),
          stats: execStats(
            execAll.filter(r => enabled.some(l => l.leg === String(r.leg)))
          ),
        }
      : null;
    return {
      member: true,
      member_until: memberUntil ? memberUntil.toISOString() : null,
      market,
      profile: prof.length
        ? {
            legs: prof.map(p => ({
              leg: String(p.leg),
              principal: Number(p.principal),
              start_date: String(p.start_date || ''),
              status: String(p.status || 'active'),
            })),
          }
        : null,
      legs,
      curve: curves.length ? combineCurves(curves) : [],
      totals,
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
      shares: r.shares == null ? null : Number(r.shares),
      amount: r.amount == null ? null : Number(r.amount),
      status: r.status || 'auto',
      note: r.note || '',
    };
  }

  /**
   * 档案保存（会员专属，路由把关）。规则：
   *  - 本金 ≥ 1000 元；起步日默认今天（北京），不得早于今天（不回溯记账——过去的信号你没真做过）；
   *  - 修改本金或起步日会**重开该腿账本**（删除已有记账行），前端须提示；
   *  - action: save（新建/修改）| pause（暂停：保留记录、不再记新信号）| resume（恢复，从今天起）| remove（删腿及其记录）。
   */
  async saveProfile(userId: string, memberUntil: Date | null, body: any) {
    const leg = String(body?.leg || '');
    if (!LEG_ORDER.includes(leg)) throw new Error('指数不在四腿之内');
    const action = String(body?.action || 'save');
    const today = beijingDay();
    const now = new Date();
    if (action === 'remove') {
      await this.db.exec(
        'DELETE FROM user_follow_exec WHERE user_id = ? AND leg = ?',
        [userId, leg]
      );
      await this.db.exec(
        'DELETE FROM user_follow_profile WHERE user_id = ? AND leg = ?',
        [userId, leg]
      );
      return { ok: true, reset: true };
    }
    const cur = await this.db.one(
      'SELECT principal, start_date, status FROM user_follow_profile WHERE user_id = ? AND leg = ?',
      [userId, leg]
    );
    if (action === 'pause' || action === 'resume') {
      if (!cur) throw new Error('该指数尚未开启跟车');
      await this.db.exec(
        'UPDATE user_follow_profile SET status = ?, member_until = ?, updated_at = ? WHERE user_id = ? AND leg = ?',
        [
          action === 'pause' ? 'paused' : 'active',
          memberUntil,
          now,
          userId,
          leg,
        ]
      );
      return { ok: true, status: action === 'pause' ? 'paused' : 'active' };
    }
    const principal = Math.round(Number(body?.principal) * 100) / 100;
    if (
      !Number.isFinite(principal) ||
      principal < InvestFollowService.MIN_PRINCIPAL
    )
      throw new Error(`本金至少 ${InvestFollowService.MIN_PRINCIPAL} 元`);
    if (principal > InvestFollowService.MAX_PRINCIPAL)
      throw new Error('本金超出可填范围');
    let start = String(body?.start_date || today)
      .replace(/-/g, '')
      .slice(0, 8);
    if (!/^\d{8}$/.test(start)) throw new Error('起步日格式应为 YYYYMMDD');
    if (start < today) start = today;
    let reset = false;
    if (cur) {
      const changed =
        Math.abs(Number(cur.principal) - principal) > 0.005 ||
        String(cur.start_date) !== start;
      if (changed) {
        const n = await this.db.one(
          'SELECT COUNT(*) n FROM user_follow_exec WHERE user_id = ? AND leg = ?',
          [userId, leg]
        );
        if (Number(n?.n || 0) > 0) {
          if (!body?.confirm_reset)
            throw new Error('修改本金或起步日会重新开始记账，请确认');
          await this.db.exec(
            'DELETE FROM user_follow_exec WHERE user_id = ? AND leg = ?',
            [userId, leg]
          );
          reset = true;
        }
      }
      await this.db.exec(
        'UPDATE user_follow_profile SET principal = ?, start_date = ?, status = ?, member_until = ?, updated_at = ? ' +
          'WHERE user_id = ? AND leg = ?',
        [principal, start, 'active', memberUntil, now, userId, leg]
      );
    } else {
      await this.db.exec(
        'INSERT INTO user_follow_profile (user_id, leg, principal, start_date, status, member_until, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, leg, principal, start, 'active', memberUntil, now]
      );
    }
    return { ok: true, reset, principal, start_date: start };
  }

  /** 记账行修改（只改自己的）：done＝按提醒做了；skipped＝没做；edited＝实际份额/价格不同。 */
  async updateExec(userId: string, body: any) {
    const id = Number(body?.id) || 0;
    const status = String(body?.status || '');
    if (!id) throw new Error('缺少记录编号');
    if (!['done', 'skipped', 'edited', 'auto'].includes(status))
      throw new Error('状态不合法');
    const row = await this.db.one(
      'SELECT id, side, price, bench_shares, bench_amount FROM user_follow_exec WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    if (!row) throw new Error('记录不存在');
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
      await this.db.exec(
        'UPDATE user_follow_exec SET status = ?, shares = ?, amount = ?, note = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        ['edited', shares, amount, note, now, id, userId]
      );
      return { ok: true, shares, amount };
    }
    if (status === 'auto') {
      // 撤销修改：回到自动值
      await this.db.exec(
        'UPDATE user_follow_exec SET status = ?, shares = bench_shares, amount = bench_amount, note = ?, updated_at = ? ' +
          'WHERE id = ? AND user_id = ?',
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

  /** 信号流：会员全量（最近 limit 条）；非会员只看 30 天前的历史（作为规则有效性的证据，不带比例）。 */
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
      const cutoff = beijingDay(Date.now() - 30 * 86400 * 1000);
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
