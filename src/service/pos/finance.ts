import { Provide, Inject } from '@midwayjs/core';
import { PosDbService } from './db';
import { InvestDbService } from '../invest/db';
import {
  BalanceLine,
  FxRate,
  applyEffects,
  daysBetween,
  freshness,
  isDate,
  normDate,
  summarizeWealth,
  todayCN,
} from './logic';

export const ACCOUNT_KINDS = [
  'cash',
  'bank',
  'deposit',
  'fund',
  'broker',
  'property',
  'other_asset',
  'mortgage',
  'loan',
  'credit',
  'other_liability',
] as const;
const LIABILITY_KINDS = ['mortgage', 'loan', 'credit', 'other_liability'];

export interface PosAccount {
  id: number;
  name: string;
  kind: string;
  side: 'asset' | 'liability';
  currency: string;
  liquid: boolean;
  investable: boolean;
  includeNetWorth: boolean;
  meta: Record<string, any>;
  note: string | null;
  sort: number;
  latest: {
    asOf: string;
    amount: number;
    low: number | null;
    high: number | null;
    factType: string;
    note: string | null;
  } | null;
}

const num = (v: any): number | null =>
  v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

function parseJson(s: any): any {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * 财富与收入：手录账户（现金/负债）+ invest 库只读投影（A 股/美股账户快照、汇率）。
 * invest 库任何失败都只让对应行变「缺失」，不影响整页。
 */
@Provide()
export class PosFinanceService {
  @Inject()
  db: PosDbService;

  @Inject()
  investDb: InvestDbService;

  // ------------------------------------------------------------ 账户

  async accounts(includeArchived = false): Promise<PosAccount[]> {
    const rows = await this.db.q(
      `SELECT * FROM pos_account ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY side, sort, id`
    );
    const latest = await this.db.q(
      `SELECT b.* FROM pos_balance b
       INNER JOIN (SELECT account_id, MAX(as_of) m FROM pos_balance GROUP BY account_id) t
       ON b.account_id = t.account_id AND b.as_of = t.m`
    );
    const byAcc = new Map<number, any>(latest.map((r: any) => [r.account_id, r]));
    return rows.map((r: any) => {
      const b = byAcc.get(r.id);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        side: r.side === 'liability' ? 'liability' : 'asset',
        currency: r.currency,
        liquid: !!r.liquid,
        investable: !!r.investable,
        includeNetWorth: !!r.include_networth,
        meta: parseJson(r.meta_json),
        note: r.note,
        sort: r.sort,
        latest: b
          ? {
              asOf: normDate(b.as_of)!,
              amount: Number(b.amount),
              low: num(b.amount_low),
              high: num(b.amount_high),
              factType: b.fact_type,
              note: b.note,
            }
          : null,
      };
    });
  }

  async upsertAccount(p: any): Promise<{ id: number }> {
    const name = String(p?.name || '').trim().slice(0, 64);
    if (!name) throw new Error('账户名称必填');
    const kind = ACCOUNT_KINDS.includes(p.kind) ? p.kind : 'cash';
    const side = LIABILITY_KINDS.includes(kind) ? 'liability' : 'asset';
    const currency = /^[A-Z]{3}$/.test(p.currency || '') ? p.currency : 'CNY';
    const liquid = p.liquid == null ? ['cash', 'bank', 'deposit'].includes(kind) : !!p.liquid;
    const investable =
      p.investable == null ? ['fund', 'broker'].includes(kind) : !!p.investable;
    const includeNw = p.includeNetWorth == null ? kind !== 'property' : !!p.includeNetWorth;
    const meta = JSON.stringify(p.meta && typeof p.meta === 'object' ? p.meta : {});
    const vals = [
      name,
      kind,
      side,
      currency,
      liquid ? 1 : 0,
      investable ? 1 : 0,
      includeNw ? 1 : 0,
      meta,
      p.note ? String(p.note).slice(0, 255) : null,
      Number(p.sort) || 0,
    ];
    if (p.id) {
      await this.db.exec(
        `UPDATE pos_account SET name=?, kind=?, side=?, currency=?, liquid=?, investable=?,
          include_networth=?, meta_json=?, note=?, sort=? WHERE id=?`,
        [...vals, Number(p.id)]
      );
      return { id: Number(p.id) };
    }
    const r = await this.db.exec(
      `INSERT INTO pos_account (name, kind, side, currency, liquid, investable, include_networth, meta_json, note, sort)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      vals
    );
    const id = r?.insertId;
    // 新建时可顺带录入首笔余额
    if (id && (p.amount != null || (p.low != null && p.high != null))) {
      await this.upsertBalance({
        accountId: id,
        asOf: p.asOf || todayCN(),
        amount: p.amount,
        low: p.low,
        high: p.high,
        factType: p.factType || 'reported',
        note: p.balanceNote,
      });
    }
    return { id };
  }

  /** 归档（软删）：历史余额保留，净资产不再计入。 */
  async archiveAccount(id: number, archived = true) {
    await this.db.exec('UPDATE pos_account SET archived=? WHERE id=?', [
      archived ? 1 : 0,
      Number(id),
    ]);
  }

  // ------------------------------------------------------------ 余额

  async upsertBalance(p: any) {
    const accountId = Number(p?.accountId);
    if (!accountId) throw new Error('accountId 必填');
    const asOf = p.asOf || todayCN();
    if (!isDate(asOf)) throw new Error('asOf 需为 YYYY-MM-DD');
    let amount = num(p.amount);
    const low = num(p.low);
    const high = num(p.high);
    if (amount == null && low != null && high != null) amount = (low + high) / 2;
    if (amount == null) throw new Error('金额必填（或给出区间）');
    if (low != null && high != null && low > high) throw new Error('区间下限不能大于上限');
    const factType = ['measured', 'reported', 'imported', 'estimated', 'derived'].includes(
      p.factType
    )
      ? p.factType
      : 'reported';
    await this.db.exec(
      `INSERT INTO pos_balance (account_id, as_of, amount, amount_low, amount_high, fact_type, source, note)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE amount=VALUES(amount), amount_low=VALUES(amount_low),
         amount_high=VALUES(amount_high), fact_type=VALUES(fact_type), source=VALUES(source), note=VALUES(note)`,
      [
        accountId,
        asOf,
        amount,
        low,
        high,
        factType,
        String(p.source || 'web').slice(0, 32),
        p.note ? String(p.note).slice(0, 255) : null,
      ]
    );
    return { accountId, asOf, amount };
  }

  async balances(accountId: number) {
    const rows = await this.db.q(
      'SELECT * FROM pos_balance WHERE account_id=? ORDER BY as_of DESC LIMIT 200',
      [Number(accountId)]
    );
    return rows.map((b: any) => ({
      id: b.id,
      accountId: b.account_id,
      asOf: normDate(b.as_of),
      amount: Number(b.amount),
      low: num(b.amount_low),
      high: num(b.amount_high),
      factType: b.fact_type,
      source: b.source,
      note: b.note,
    }));
  }

  async deleteBalance(id: number) {
    await this.db.exec('DELETE FROM pos_balance WHERE id=?', [Number(id)]);
  }

  /** 账户在某日（含）之前的最新余额。 */
  async balanceAsOf(accountId: number, date: string): Promise<number | null> {
    const r = await this.db.one(
      'SELECT amount FROM pos_balance WHERE account_id=? AND as_of<=? ORDER BY as_of DESC LIMIT 1',
      [accountId, date]
    );
    return r ? Number(r.amount) : null;
  }

  /** 事件结转：按 effects 给各账户在 date 写一条派生余额（同日已有则在其上叠加）。 */
  async applyEventEffects(
    date: string,
    effects: Array<{ accountId: number; delta: number }>,
    note: string
  ) {
    const prev: Record<number, number | null> = {};
    for (const e of effects) prev[e.accountId] = await this.balanceAsOf(e.accountId, date);
    const plan = applyEffects(prev, effects);
    // 资产账户结转后为负＝钱其实不是从这里出的：拒绝，而不是记一笔负现金
    const accs = await this.accounts(true);
    for (const p of plan) {
      const acc = accs.find(a => a.id === p.accountId);
      if (!acc) throw new Error(`账户 #${p.accountId} 不存在`);
      if (p.next < 0)
        throw new Error(
          `「${acc.name}」结转后为 ${p.next}，${acc.side === 'asset' ? '余额不足，请确认实际资金来源' : '负债不能为负'}`
        );
    }
    for (const p of plan) {
      await this.upsertBalance({
        accountId: p.accountId,
        asOf: date,
        amount: p.next,
        factType: 'derived',
        source: 'event',
        note: note.slice(0, 255),
      });
    }
    return plan;
  }

  // ------------------------------------------------------------ 资金流

  async flows(limit = 100) {
    const rows = await this.db.q(
      'SELECT * FROM pos_flow ORDER BY flow_date DESC, id DESC LIMIT ?',
      [Math.min(500, Number(limit) || 100)]
    );
    return rows.map((r: any) => ({
      id: r.id,
      accountKey: r.account_key,
      date: normDate(r.flow_date),
      amount: Number(r.amount),
      currency: r.currency,
      kind: r.kind,
      note: r.note,
    }));
  }

  async addFlow(p: any) {
    const date = p?.date || todayCN();
    if (!isDate(date)) throw new Error('date 需为 YYYY-MM-DD');
    const amount = num(p.amount);
    if (amount == null || amount === 0) throw new Error('金额必填（入金为正、出金为负）');
    const key = String(p.accountKey || '').slice(0, 32);
    if (!key) throw new Error('accountKey 必填');
    const kind = ['deposit', 'withdraw', 'dividend', 'fee', 'transfer'].includes(p.kind)
      ? p.kind
      : amount > 0
        ? 'deposit'
        : 'withdraw';
    const r = await this.db.exec(
      'INSERT INTO pos_flow (account_key, flow_date, amount, currency, kind, note) VALUES (?,?,?,?,?,?)',
      [
        key,
        date,
        amount,
        /^[A-Z]{3}$/.test(p.currency || '') ? p.currency : 'CNY',
        kind,
        p.note ? String(p.note).slice(0, 255) : null,
      ]
    );
    return { id: r?.insertId };
  }

  async deleteFlow(id: number) {
    await this.db.exec('DELETE FROM pos_flow WHERE id=?', [Number(id)]);
  }

  // ------------------------------------------------------------ 收入

  async incomes(months = 24) {
    const rows = await this.db.q(
      'SELECT * FROM pos_income ORDER BY period DESC, id DESC LIMIT ?',
      [Math.min(600, months * 6)]
    );
    return rows.map((r: any) => ({
      id: r.id,
      kind: r.kind,
      period: r.period,
      receivedDate: normDate(r.received_date),
      amount: Number(r.amount),
      currency: r.currency,
      basis: r.basis,
      factType: r.fact_type,
      note: r.note,
    }));
  }

  async upsertIncome(p: any) {
    const period = String(p?.period || todayCN().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period 需为 YYYY-MM');
    const amount = num(p.amount);
    if (amount == null) throw new Error('金额必填');
    const kind = ['salary', 'bonus', 'equity', 'side', 'other'].includes(p.kind) ? p.kind : 'salary';
    const basis = ['gross', 'net', 'unknown'].includes(p.basis) ? p.basis : 'unknown';
    const vals = [
      kind,
      period,
      isDate(p.receivedDate) ? p.receivedDate : null,
      amount,
      /^[A-Z]{3}$/.test(p.currency || '') ? p.currency : 'CNY',
      basis,
      ['measured', 'reported', 'imported', 'estimated'].includes(p.factType) ? p.factType : 'reported',
      p.note ? String(p.note).slice(0, 255) : null,
    ];
    if (p.id) {
      await this.db.exec(
        `UPDATE pos_income SET kind=?, period=?, received_date=?, amount=?, currency=?, basis=?, fact_type=?, note=? WHERE id=?`,
        [...vals, Number(p.id)]
      );
      return { id: Number(p.id) };
    }
    const r = await this.db.exec(
      `INSERT INTO pos_income (kind, period, received_date, amount, currency, basis, fact_type, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      vals
    );
    return { id: r?.insertId };
  }

  async deleteIncome(id: number) {
    await this.db.exec('DELETE FROM pos_income WHERE id=?', [Number(id)]);
  }

  // ------------------------------------------------------------ invest 库投影

  /** A 股账户快照（invest 库 account_snapshot，每日按收盘重估）。 */
  async investA(): Promise<{
    latest: { asOf: string; cash: number; marketValue: number; total: number } | null;
    series: Array<{ date: string; total: number }>;
    top: Array<{ code: string; name: string; marketValue: number; weight: number }>;
    error?: string;
  }> {
    try {
      const rows = await this.investDb.q(
        'SELECT snapshot_date, cash, market_value, total_asset FROM account_snapshot ORDER BY snapshot_date'
      );
      const series = rows
        .map((r: any) => ({ date: normDate(r.snapshot_date)!, total: Number(r.total_asset) }))
        .filter(r => r.date && Number.isFinite(r.total));
      const last: any = rows[rows.length - 1];
      let top: any[] = [];
      if (last) {
        const hs = await this.investDb
          .q(
            `SELECT code, name, market_value FROM holding_snapshot
             WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM holding_snapshot)
             ORDER BY market_value DESC LIMIT 5`
          )
          .catch(() => []);
        const total = Number(last.total_asset) || 0;
        top = hs.map((h: any) => ({
          code: h.code,
          name: h.name,
          marketValue: Number(h.market_value) || 0,
          weight: total ? Math.round((Number(h.market_value) / total) * 10000) / 10000 : 0,
        }));
      }
      return {
        latest: last
          ? {
              asOf: normDate(last.snapshot_date)!,
              cash: Number(last.cash) || 0,
              marketValue: Number(last.market_value) || 0,
              total: Number(last.total_asset) || 0,
            }
          : null,
        series,
        top,
      };
    } catch (e: any) {
      return { latest: null, series: [], top: [], error: e?.message || String(e) };
    }
  }

  /** 美股账户快照（invest 库 us_account_snapshot，USD 原币）。 */
  async investUs(): Promise<{
    latest: { asOf: string; total: number } | null;
    series: Array<{ date: string; total: number }>;
    error?: string;
  }> {
    try {
      const rows = await this.investDb.q(
        'SELECT snapshot_date, total_asset FROM us_account_snapshot ORDER BY snapshot_date'
      );
      const series = rows
        .map((r: any) => ({ date: normDate(r.snapshot_date)!, total: Number(r.total_asset) }))
        .filter(r => r.date && Number.isFinite(r.total) && r.total > 0);
      const last = series[series.length - 1];
      return { latest: last ? { asOf: last.date, total: last.total } : null, series };
    } catch (e: any) {
      return { latest: null, series: [], error: e?.message || String(e) };
    }
  }

  /**
   * 美元兑人民币：优先手录（pos_metric fx.usdcny，你确认过的数），其次 invest 库宏观序列；
   * 两者都无则返回 null——绝不使用默认汇率。
   */
  async fxUsd(): Promise<FxRate | null> {
    const manual = await this.db
      .one(
        "SELECT observed_on, value FROM pos_metric WHERE metric_key='fx.usdcny' ORDER BY observed_on DESC LIMIT 1"
      )
      .catch(() => null);
    let macro: FxRate | null = null;
    try {
      const r = await this.investDb.one(
        `SELECT period, value FROM macro_series
         WHERE series IN ('fx_daily.bid_close','fx_daily.close') ORDER BY period DESC LIMIT 1`
      );
      if (r && Number(r.value) > 0)
        macro = { rate: Number(r.value), asOf: normDate(r.period)!, source: 'invest 宏观库' };
    } catch {
      /* ignore */
    }
    const man: FxRate | null =
      manual && Number(manual.value) > 0
        ? { rate: Number(manual.value), asOf: normDate(manual.observed_on)!, source: '手录' }
        : null;
    if (man && macro) return man.asOf >= macro.asOf ? man : macro;
    return man || macro;
  }

  // ------------------------------------------------------------ 汇总

  async wealth() {
    const today = todayCN();
    const [accounts, a, us, fx] = await Promise.all([
      this.accounts(),
      this.investA(),
      this.investUs(),
      this.fxUsd(),
    ]);
    const lines: BalanceLine[] = [];
    if (a.latest)
      lines.push({
        key: 'invest_a',
        name: 'A 股账户',
        kind: 'broker',
        side: 'asset',
        currency: 'CNY',
        amount: a.latest.total,
        asOf: a.latest.asOf,
        factType: 'imported',
        source: 'invest 系统·每日收盘重估',
        liquid: false,
        investable: true,
        includeNetWorth: true,
        freshness: freshness('invest_a', a.latest.asOf, today).status,
      });
    if (us.latest)
      lines.push({
        key: 'invest_us',
        name: '美股账户',
        kind: 'broker',
        side: 'asset',
        currency: 'USD',
        amount: us.latest.total,
        asOf: us.latest.asOf,
        factType: 'imported',
        source: 'invest 系统·美股快照',
        liquid: false,
        investable: true,
        includeNetWorth: true,
        freshness: freshness('invest_us', us.latest.asOf, today).status,
      });
    for (const acc of accounts) {
      lines.push({
        key: `pos:${acc.id}`,
        name: acc.name,
        kind: acc.kind,
        side: acc.side,
        currency: acc.currency,
        amount: acc.latest ? acc.latest.amount : null,
        low: acc.latest?.low ?? null,
        high: acc.latest?.high ?? null,
        asOf: acc.latest?.asOf ?? null,
        factType: acc.latest?.factType ?? 'unknown',
        source: '手录',
        liquid: acc.liquid,
        investable: acc.investable,
        includeNetWorth: acc.includeNetWorth,
        freshness: freshness('balance', acc.latest?.asOf ?? null, today).status,
      });
    }
    const summary = summarizeWealth(lines, { USD: fx, CNY: null });
    return {
      today,
      fx: { USD: fx },
      summary,
      accounts,
      investA: a,
      investUs: us,
      series: await this.netWorthSeries(accounts, a.series, us.series, fx),
    };
  }

  /**
   * 净资产月度序列：近 12 个月每月末 + 今天，各成分取「该日及之前最新值」。
   * 美元按当前汇率折算（历史汇率入库前的近似，前端注明）。
   */
  private async netWorthSeries(
    accounts: PosAccount[],
    aSeries: Array<{ date: string; total: number }>,
    usSeries: Array<{ date: string; total: number }>,
    fx: FxRate | null
  ) {
    const all = await this.db.q('SELECT account_id, as_of, amount FROM pos_balance ORDER BY as_of');
    const byAcc = new Map<number, Array<{ date: string; amount: number }>>();
    for (const r of all as any[]) {
      const list = byAcc.get(r.account_id) || [];
      list.push({ date: normDate(r.as_of)!, amount: Number(r.amount) });
      byAcc.set(r.account_id, list);
    }
    const lastAt = <T extends { date: string }>(list: T[], d: string): T | null => {
      let hit: T | null = null;
      for (const x of list) if (x.date <= d) hit = x;
      return hit;
    };
    const today = todayCN();
    const dates: string[] = [];
    const [y, m] = today.split('-').map(Number);
    for (let i = 11; i >= 1; i--) {
      const dt = new Date(Date.UTC(y, m - i, 0)); // 上 i 个月的月末
      dates.push(dt.toISOString().slice(0, 10));
    }
    dates.push(today);
    const out: Array<{ date: string; assets: number; liabilities: number; netWorth: number }> = [];
    for (const d of dates) {
      let assets = 0;
      let liab = 0;
      let any = false;
      const a = lastAt(aSeries, d);
      if (a) {
        assets += a.total;
        any = true;
      }
      const u = lastAt(usSeries, d);
      if (u && fx) {
        assets += u.total * fx.rate;
        any = true;
      }
      for (const acc of accounts) {
        if (!acc.includeNetWorth) continue;
        const b = lastAt(byAcc.get(acc.id) || [], d);
        if (!b) continue;
        any = true;
        const v = acc.currency === 'CNY' ? b.amount : fx && acc.currency === 'USD' ? b.amount * fx.rate : null;
        if (v == null) continue;
        if (acc.side === 'liability') liab += v;
        else assets += v;
      }
      if (any)
        out.push({
          date: d,
          assets: Math.round(assets),
          liabilities: Math.round(liab),
          netWorth: Math.round(assets - liab),
        });
    }
    return out;
  }

  /** 收入汇总：最近一次工资、近 12 个月合计（按类型、按税前/税后分开，不混算）。 */
  async incomeSummary() {
    const list = await this.incomes(12);
    const today = todayCN();
    const cutoff = (() => {
      const [y, m] = today.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 12, 1));
      return d.toISOString().slice(0, 7);
    })();
    const recent = list.filter(i => i.period >= cutoff);
    const salary = list.find(i => i.kind === 'salary') || null;
    const byKind: Record<string, Record<string, number>> = {};
    for (const i of recent) {
      byKind[i.kind] = byKind[i.kind] || {};
      byKind[i.kind][i.basis] = (byKind[i.kind][i.basis] || 0) + i.amount;
    }
    return {
      latestSalary: salary,
      last12ByKindBasis: byKind,
      salaryAgeDays: salary
        ? daysBetween(salary.receivedDate || `${salary.period}-28`, today)
        : null,
    };
  }
}
