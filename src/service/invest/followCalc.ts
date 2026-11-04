/**
 * 跟车换算的纯函数层（2026-11-02）。与 invest-model `orchestration/broad_follow.py` 同一套算术：
 * **一个总资金、一个现金池**（owner 2026-11-02 晚「跟车肯定是有一个总额，然后模型进行分配持有」）：
 * 每个执行日先卖后买；买入前把现金池按四个指数均分计量，各指数当天只按自己那份×比例买（同指数同日多笔按花掉的钱递减）；
 * 卖出回笼的钱回到池里共用。份额向下取整到 100 份；卖＝该指数持仓×比例四舍五入到 100 份、不超过整手持仓；
 * 现金不计利息。自动记账由 Python 端在执行日收盘后写入；这里只做「今日换算预览」与「净值/执行率」的汇总，
 * 不做任何路径重放——两边的算术用 test/invest/follow.test.ts 钉在一起。
 */

export const LOT = 100;
/** 页面展示顺序（全站统一：沪深300 → 红利 → 创业板 → 科创50） */
export const LEG_ORDER = ['沪深300', '红利', '创业板', '科创50'];
/** 同一执行日内的处理顺序（与 Python LEG_RANK 一致）；现金池按这 4 个指数均分计量 */
export const PLAN_ORDER = ['沪深300', '创业板', '科创50', '红利'];
export const N_LEGS = PLAN_ORDER.length;
export const LEG_ETF: Record<string, string> = {
  沪深300: '510300.SH',
  创业板: '159915.SZ',
  科创50: '588000.SH',
  红利: '515080.SH',
};
export const ETF_NAME: Record<string, string> = {
  '510300.SH': '沪深300ETF',
  '159915.SZ': '创业板ETF',
  '588000.SH': '科创50ETF',
  '515080.SH': '红利ETF',
};
export const KIND_CN: Record<string, string> = {
  panic_buy: '恐慌抢买',
  anchor_buy: '低位分批买入',
  ladder_buy: '深跌阶梯加码',
  sell: '高位月度减仓',
};

export interface ExecRow {
  id?: number;
  leg: string;
  bench_fee?: number | null;
  fee?: number | null;
  signal_date: string;
  kind: string;
  exec_date: string;
  etf?: string;
  side: 'buy' | 'sell' | string;
  frac?: number;
  price?: number | null;
  bench_shares?: number | null;
  bench_amount?: number | null;
  shares?: number | null;
  amount?: number | null;
  status?: string | null;
  note?: string | null;
}

/** 场内 ETF 单笔佣金：成交额×费率、不足最低按最低；费率与最低都为 0 ⟹ 0（ETF 免印花税）。 */
export function tradeFee(value: number, feeRate = 0, minFee = 0): number {
  if (!(value > 0) || (feeRate <= 0 && minFee <= 0)) return 0;
  return Math.max(value * feeRate, minFee);
}

/**
 * 按 100 份取整的下单量。买＝「现金×比例」是含佣金的预算：整手向下取整、成交额+佣金不超预算；
 * 卖＝持仓×比例四舍五入到整手、不超过持仓。与 Python size_order 同一套算术。
 */
export function sizeOrder(
  side: string,
  frac: number,
  cash: number,
  units: number,
  price: number | null | undefined,
  feeRate = 0,
  minFee = 0
): { shares: number; amount: number; fee: number } {
  if (price == null || !(price > 0)) return { shares: 0, amount: 0, fee: 0 };
  let sh: number;
  if (side === 'buy') {
    const budget = Math.max(cash, 0) * frac;
    sh = Math.floor(budget / (price * (1 + Math.max(feeRate, 0))) / LOT) * LOT;
    while (
      sh > 0 &&
      sh * price + tradeFee(sh * price, feeRate, minFee) > budget + 1e-9
    )
      sh -= LOT;
  } else {
    sh = Math.floor((units * frac) / LOT + 0.5) * LOT;
    sh = Math.min(sh, Math.floor(units / LOT) * LOT);
  }
  sh = Math.max(sh, 0);
  const fee =
    sh > 0 ? Math.round(tradeFee(sh * price, feeRate, minFee) * 100) / 100 : 0;
  return { shares: sh, amount: Math.round(sh * price * 100) / 100, fee };
}

/** 资金进出流水：amount>0 追加、<0 取出；flow_date 当天的执行记完之后、下一笔信号之前计入现金。 */
export interface CashFlow {
  id?: number;
  leg?: string;
  flow_date: string;
  amount: number;
  note?: string | null;
}

/** 记账行与资金流按日期合并：同一天先记执行（0）、后计资金流（1）。与 Python _events 同序。 */
export function mergeEvents(
  rows: ExecRow[],
  flows: CashFlow[] = []
): { kind: 'exec' | 'flow'; date: string; row?: ExecRow; flow?: CashFlow }[] {
  const ev: {
    kind: 'exec' | 'flow';
    date: string;
    order: number;
    i: number;
    row?: ExecRow;
    flow?: CashFlow;
  }[] = [];
  rows.forEach((r, i) =>
    ev.push({
      kind: 'exec',
      date: String(r.exec_date || ''),
      order: 0,
      i,
      row: r,
    })
  );
  flows.forEach((f, i) =>
    ev.push({
      kind: 'flow',
      date: String(f.flow_date || ''),
      order: 1,
      i,
      flow: f,
    })
  );
  ev.sort(
    (a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.i - b.i
  );
  return ev.map(({ kind, date, row, flow }) => ({ kind, date, row, flow }));
}

/** 由记账行（+资金流）汇总组合状态 (现金池, {指数: 份额})。bench 用完美跟车值；否则用用户实际值（skipped 不计）。 */
export function portfolioState(
  principal: number,
  rows: ExecRow[],
  bench: boolean,
  flows: CashFlow[] = []
): { cash: number; units: Record<string, number> } {
  let cash = Number(principal) || 0;
  const units: Record<string, number> = {};
  for (const l of PLAN_ORDER) units[l] = 0;
  for (const e of mergeEvents(rows, flows)) {
    if (e.kind === 'flow') {
      cash += Number(e.flow!.amount) || 0;
      continue;
    }
    const r = e.row!;
    let sh: number;
    let amt: number;
    let fee: number;
    if (bench) {
      sh = Number(r.bench_shares || 0);
      amt = Number(r.bench_amount || 0);
      fee = Number(r.bench_fee || 0);
    } else {
      if (String(r.status || '') === 'skipped') continue;
      sh = Number(r.shares || 0);
      amt = Number(r.amount || 0);
      fee = Number(r.fee || 0);
    }
    const leg = String(r.leg);
    if (String(r.side) === 'buy') {
      cash -= amt + fee;
      units[leg] = (units[leg] || 0) + sh;
    } else {
      cash += amt - fee;
      units[leg] = Math.max((units[leg] || 0) - sh, 0);
    }
  }
  return { cash: Math.round(cash * 100) / 100, units };
}

export interface PlanSignal {
  leg: string;
  side: string;
  frac: number;
  kind: string;
  etf: string;
  seq?: number;
  exec_date?: string | null;
}

/** 同一执行日内的顺序：先卖后买，同方向按 PLAN_ORDER、再按 seq（与 Python signal_order 同序）。 */
export function signalOrder(a: PlanSignal, b: PlanSignal): number {
  const sa = a.side === 'sell' ? 0 : 1;
  const sb = b.side === 'sell' ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const ra = PLAN_ORDER.indexOf(a.leg);
  const rb = PLAN_ORDER.indexOf(b.leg);
  if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  return (a.seq || 0) - (b.seq || 0);
}

export interface PlanItem {
  sig: PlanSignal;
  shares: number;
  amount: number;
  fee: number;
  skipped: boolean;
  reason: string;
  text: string;
  cashAfter: number;
  unitsAfter: number;
}

/**
 * 一个执行日的全部信号在组合上的换算（P110 分配规则）：先卖后买；买入前把现金池÷N_LEGS 作为各指数当天的额度，
 * 买入预算＝额度×比例，同指数多笔按花掉的钱递减；卖出回笼的现金当天可用。与 Python day_plan 同一算术。
 * priceOf(leg) 给该指数最新价；缺价的信号给出「份额待算」且不动状态。返回逐笔明细与推进后的 (现金, 持仓)。
 */
export function dayPlan(
  cash: number,
  units: Record<string, number>,
  signals: PlanSignal[],
  priceOf: (leg: string) => number | null | undefined,
  feeRate = 0,
  minFee = 0
): { items: PlanItem[]; cash: number; units: Record<string, number> } {
  const u: Record<string, number> = { ...units };
  let c = cash;
  let quarter: Record<string, number> | null = null;
  const items: PlanItem[] = [];
  for (const sig of [...signals].sort(signalOrder)) {
    const leg = sig.leg;
    const price = priceOf(leg);
    const have = u[leg] || 0;
    if (sig.side === 'sell' && have <= 0) {
      items.push({
        sig,
        shares: 0,
        amount: 0,
        fee: 0,
        skipped: true,
        reason: '没有该指数持仓',
        text: `${legName(sig.etf)}：你没有这个指数的持仓，本次无需操作`,
        cashAfter: c,
        unitsAfter: 0,
      });
      continue;
    }
    if (sig.side === 'sell') {
      const a = advise(sig, c, have, price, feeRate, minFee);
      items.push({ sig, ...a });
      if (price != null && price > 0) {
        c = a.cashAfter;
        u[leg] = a.unitsAfter;
      }
      continue;
    }
    if (quarter == null) {
      quarter = {};
      for (const l of PLAN_ORDER) quarter[l] = Math.max(c, 0) / N_LEGS;
    }
    const a = advise(sig, quarter[leg] || 0, have, price, feeRate, minFee);
    // advise 按「额度」算份额；现金池的前后值按真实现金给
    const spend = a.amount + a.fee;
    const item: PlanItem = {
      sig,
      ...a,
      cashAfter: Math.round((c - spend) * 100) / 100,
      unitsAfter: have + a.shares,
    };
    items.push(item);
    if (price != null && price > 0) {
      c = item.cashAfter;
      quarter[leg] = Math.max((quarter[leg] || 0) - spend, 0);
      u[leg] = item.unitsAfter;
    }
  }
  return { items, cash: Math.round(c * 100) / 100, units: u };
}

const legName = (etf: string) =>
  `${ETF_NAME[etf] || etf}（${String(etf).split('.')[0]}）`;

/** 单指数口径的 (现金, 份额)，只给旧测试兼容；生产用 portfolioState。 */
export function stateFromRows(
  principal: number,
  rows: ExecRow[],
  bench: boolean,
  flows: CashFlow[] = []
): { cash: number; units: number } {
  let cash = Number(principal) || 0;
  let units = 0;
  for (const e of mergeEvents(rows, flows)) {
    if (e.kind === 'flow') {
      cash += Number(e.flow!.amount) || 0;
      continue;
    }
    const r = e.row!;
    let sh: number;
    let amt: number;
    let fee: number;
    if (bench) {
      sh = Number(r.bench_shares || 0);
      amt = Number(r.bench_amount || 0);
      fee = Number(r.bench_fee || 0);
    } else {
      if (String(r.status || '') === 'skipped') continue;
      sh = Number(r.shares || 0);
      amt = Number(r.amount || 0);
      fee = Number(r.fee || 0);
    }
    // 佣金从现金扣：买＝成交额+佣金，卖＝成交额−佣金
    if (String(r.side) === 'buy') {
      cash -= amt + fee;
      units += sh;
    } else {
      cash += amt - fee;
      units -= sh;
    }
  }
  return { cash: Math.round(cash * 100) / 100, units: Math.max(units, 0) };
}

/**
 * 组合逐日净值：closes 为各指数 ETF 自起步日起的收盘序列（升序），记账行按 exec_date 当天生效。
 * 日期取并集；某指数当日无收盘沿用其最近一次收盘（前向填充）。返回 [{date, nav, bench, unit, bench_unit}]；
 * nav = 现金池 + Σ 份额×收盘。
 */
export function navSeries(
  principal: number,
  rows: ExecRow[],
  closesByLeg: Record<string, { date: string; close: number }[]>,
  flows: CashFlow[] = []
): {
  date: string;
  nav: number;
  bench: number;
  unit: number;
  bench_unit: number;
}[] {
  const sorted = [...rows].sort((a, b) =>
    a.exec_date === b.exec_date
      ? String(a.signal_date).localeCompare(String(b.signal_date))
      : String(a.exec_date).localeCompare(String(b.exec_date))
  );
  const fl = [...flows].sort((a, b) =>
    String(a.flow_date).localeCompare(String(b.flow_date))
  );
  const dates = new Set<string>();
  for (const leg of Object.keys(closesByLeg))
    for (const c of closesByLeg[leg]) dates.add(c.date);
  const days = [...dates].sort();
  const idx: Record<string, number> = {};
  const last: Record<string, number> = {};
  for (const leg of Object.keys(closesByLeg)) idx[leg] = 0;
  const out: { date: string; nav: number; bench: number }[] = [];
  let i = 0;
  let j = 0;
  const applied: ExecRow[] = [];
  const appliedFlows: CashFlow[] = [];
  for (const d of days) {
    while (i < sorted.length && String(sorted[i].exec_date) <= d) {
      applied.push(sorted[i]);
      i += 1;
    }
    while (j < fl.length && String(fl[j].flow_date) <= d) {
      appliedFlows.push(fl[j]);
      j += 1;
    }
    for (const leg of Object.keys(closesByLeg)) {
      const arr = closesByLeg[leg];
      while (idx[leg] < arr.length && arr[idx[leg]].date <= d) {
        last[leg] = arr[idx[leg]].close;
        idx[leg] += 1;
      }
    }
    const a = portfolioState(principal, applied, false, appliedFlows);
    const b = portfolioState(principal, applied, true, appliedFlows);
    const val = (st: { cash: number; units: Record<string, number> }) =>
      st.cash +
      Object.keys(st.units).reduce(
        (s, leg) => s + st.units[leg] * (last[leg] || 0),
        0
      );
    out.push({
      date: d,
      nav: Math.round(val(a) * 100) / 100,
      bench: Math.round(val(b) * 100) / 100,
    });
  }
  const unit = unitNavSeries(
    principal,
    out.map(o => ({ date: o.date, value: o.nav })),
    fl
  );
  const bunit = unitNavSeries(
    principal,
    out.map(o => ({ date: o.date, value: o.bench })),
    fl
  );
  return out.map((o, k) => ({ ...o, unit: unit[k], bench_unit: bunit[k] }));
}

/**
 * 份额法单位净值（时间加权）：values 为逐日「当日全部事件后的总市值」，flows 为资金流。起点 1.0；
 * 资金流当日先按流入前市值 (V − F) 定价、再按该价增减基金份额 ⟹ 当日单位净值不因出入金跳变。
 * 与 invest-model broad_follow.unit_nav_series 同一算术。
 */
export function unitNavSeries(
  principal: number,
  values: { date: string; value: number }[],
  flows: CashFlow[] = []
): number[] {
  const fsum = new Map<string, number>();
  for (const f of flows) {
    const d = String(f.flow_date || '');
    fsum.set(d, (fsum.get(d) || 0) + (Number(f.amount) || 0));
  }
  let fundUnits = principal > 0 ? Number(principal) : 1;
  const out: number[] = [];
  for (const v of values) {
    const f = fsum.get(v.date) || 0;
    if (f && fundUnits > 0) {
      const pre = v.value - f;
      const u = pre > 0 ? pre / fundUnits : 1;
      fundUnits += f / u;
    }
    out.push(fundUnits > 0 ? Math.round((v.value / fundUnits) * 1e6) / 1e6 : 1);
  }
  return out;
}

/** 资金加权年化（XIRR，二分法）。cashflows：投入为负、取出与期末市值为正；不足两笔或无解返回 null。 */
export function xirr(flows: { date: string; amount: number }[]): number | null {
  const fs = flows.filter(f => Number.isFinite(f.amount) && f.amount !== 0);
  if (fs.length < 2) return null;
  const t0 = toTime(fs[0].date);
  const yrs = fs.map(f => (toTime(f.date) - t0) / (365.25 * 86400000));
  if (!(Math.max(...yrs) > 0)) return null;
  const npv = (r: number) =>
    fs.reduce((s, f, k) => s + f.amount / Math.pow(1 + r, yrs[k]), 0);
  let lo = -0.99;
  let hi = 10;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0)
    return null;
  for (let k = 0; k < 200; k += 1) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-8 || hi - lo < 1e-10)
      return Math.round(mid * 1e6) / 1e6;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return Math.round(((lo + hi) / 2) * 1e6) / 1e6;
}

const toTime = (d: string) =>
  Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));

/** 执行率：记录里非 skipped 的占比（auto 视为已按提醒执行）。 */
export function execStats(rows: ExecRow[]): {
  total: number;
  done: number;
  skipped: number;
  edited: number;
  rate: number | null;
} {
  const total = rows.length;
  const skipped = rows.filter(r => String(r.status || '') === 'skipped').length;
  const edited = rows.filter(r => String(r.status || '') === 'edited').length;
  const done = total - skipped;
  return {
    total,
    done,
    skipped,
    edited,
    rate: total ? Math.round((done / total) * 1000) / 10 : null,
  };
}

const isoWeek = (d: string) => {
  const dt = new Date(
    Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))
  );
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt.getTime() - y0.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-${wk}`;
};

/**
 * 下一个检查日：openDays 为升序的交易日列表（含今天之后若干天）。
 * weekEnd＝今天或之后第一个「下一交易日属于另一个 ISO 周」的交易日；monthEnd 同理按月。
 */
export function nextCheckDates(
  openDays: string[],
  today: string
): { weekEnd: string | null; monthEnd: string | null } {
  // 「下次」检查日：严格晚于判定日。判定日本身是周五/月末时，它的检查已经做过（信号已出），
  // 再把它当「下次」会让页面在之后几天一直显示一个过去的日期（2026-11-04 实测）。
  const days = openDays.filter(d => d > today).sort();
  let weekEnd: string | null = null;
  let monthEnd: string | null = null;
  for (let i = 0; i + 1 < days.length; i += 1) {
    const cur = days[i];
    const nxt = days[i + 1];
    if (weekEnd == null && isoWeek(cur) !== isoWeek(nxt)) weekEnd = cur;
    if (monthEnd == null && cur.slice(0, 6) !== nxt.slice(0, 6)) monthEnd = cur;
    if (weekEnd && monthEnd) break;
  }
  return { weekEnd, monthEnd };
}

export const fmtMoney = (v: number) =>
  `${Math.round(v).toLocaleString('zh-CN')} 元`;

/** 一条今日信号在某腿账户上的换算预览（按最新收盘估；实际记账用执行日收盘）。 */
export function advise(
  sig: { side: string; frac: number; kind: string; etf: string },
  cash: number,
  units: number,
  price: number | null | undefined,
  feeRate = 0,
  minFee = 0
): {
  shares: number;
  amount: number;
  fee: number;
  skipped: boolean;
  reason: string;
  text: string;
  cashAfter: number;
  unitsAfter: number;
} {
  const { shares, amount, fee } = sizeOrder(
    sig.side,
    sig.frac,
    cash,
    units,
    price,
    feeRate,
    minFee
  );
  const name = `${ETF_NAME[sig.etf] || sig.etf}（${
    String(sig.etf).split('.')[0]
  }）`;
  const pct = `${Math.round(sig.frac * 100)}%`;
  const feeTxt = fee > 0 ? `，佣金约 ${fee.toFixed(2)} 元` : '';
  if (price == null || !(price > 0)) {
    return {
      shares: 0,
      amount: 0,
      fee: 0,
      skipped: false,
      reason: '暂无最新收盘价',
      text: `${name}：${
        sig.side === 'buy' ? `买入当前现金的 ${pct}` : `卖出当前持仓的 ${pct}`
      }（暂无收盘价，份额待算）`,
      cashAfter: cash,
      unitsAfter: units,
    };
  }
  if (shares <= 0) {
    const reason = sig.side === 'buy' ? '现金不足一手' : '持仓不足一手的比例';
    return {
      shares: 0,
      amount: 0,
      fee: 0,
      skipped: true,
      reason,
      text: `${name}：${reason}，本次按规则跳过`,
      cashAfter: cash,
      unitsAfter: units,
    };
  }
  if (sig.side === 'buy') {
    return {
      shares,
      amount,
      fee,
      skipped: false,
      reason: '',
      text: `${name} 买入 ${shares.toLocaleString('zh-CN')} 份，约 ${fmtMoney(
        amount
      )}${feeTxt}`,
      cashAfter: Math.round((cash - amount - fee) * 100) / 100,
      unitsAfter: units + shares,
    };
  }
  return {
    shares,
    amount,
    fee,
    skipped: false,
    reason: '',
    text: `${name} 卖出 ${shares.toLocaleString('zh-CN')} 份，约 ${fmtMoney(
      amount
    )}${feeTxt}`,
    cashAfter: Math.round((cash + amount - fee) * 100) / 100,
    unitsAfter: units - shares,
  };
}

/**
 * 多腿净值曲线合并：按日期并集逐日相加，某腿当日无收盘时沿用它最近一次的值（前向填充）。
 * 起步日之前的腿按本金计（现金躺着，不计利息）。
 */
export function combineCurves(
  curves: {
    principal: number;
    series: { date: string; nav: number; bench: number }[];
  }[]
): { date: string; nav: number; bench: number }[] {
  const dates = new Set<string>();
  for (const c of curves) for (const p of c.series) dates.add(p.date);
  const sorted = [...dates].sort();
  const idx = curves.map(() => 0);
  const last = curves.map(c => ({
    nav: Number(c.principal) || 0,
    bench: Number(c.principal) || 0,
  }));
  return sorted.map(d => {
    let nav = 0;
    let bench = 0;
    curves.forEach((c, k) => {
      while (idx[k] < c.series.length && c.series[idx[k]].date <= d) {
        last[k] = { nav: c.series[idx[k]].nav, bench: c.series[idx[k]].bench };
        idx[k] += 1;
      }
      nav += last[k].nav;
      bench += last[k].bench;
    });
    return {
      date: d,
      nav: Math.round(nav * 100) / 100,
      bench: Math.round(bench * 100) / 100,
    };
  });
}
