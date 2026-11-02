/**
 * 跟车换算的纯函数层（2026-11-02）。与 invest-model `orchestration/broad_follow.py` 同一套算术：
 * 买＝当前现金×比例、份额向下取整到 100 份；卖＝当前持仓×比例、四舍五入（半数进一）到 100 份、
 * 不超过整手持仓；现金 = 本金 − 买入金额 + 卖出金额，不计利息。
 * 自动记账由 Python 端在执行日收盘后写入；这里只做「今日换算预览」与「净值/执行率」的汇总，
 * 不做任何路径重放——两边的算术用 test/invest/follow.test.ts 钉在一起。
 */

export const LOT = 100;
export const LEG_ORDER = ['沪深300', '红利', '创业板', '科创50'];
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

export function sizeOrder(
  side: string,
  frac: number,
  cash: number,
  units: number,
  price: number | null | undefined
): { shares: number; amount: number } {
  if (price == null || !(price > 0)) return { shares: 0, amount: 0 };
  let sh: number;
  if (side === 'buy') {
    const amt = Math.max(cash, 0) * frac;
    sh = Math.floor(amt / price / LOT) * LOT;
  } else {
    sh = Math.floor((units * frac) / LOT + 0.5) * LOT;
    sh = Math.min(sh, Math.floor(units / LOT) * LOT);
  }
  sh = Math.max(sh, 0);
  return { shares: sh, amount: Math.round(sh * price * 100) / 100 };
}

/** 由记账行汇总 (现金, 持仓份额)。bench 用完美跟车值；否则用用户实际值（skipped 不计）。 */
export function stateFromRows(
  principal: number,
  rows: ExecRow[],
  bench: boolean
): { cash: number; units: number } {
  let cash = Number(principal) || 0;
  let units = 0;
  for (const r of rows) {
    let sh: number;
    let amt: number;
    if (bench) {
      sh = Number(r.bench_shares || 0);
      amt = Number(r.bench_amount || 0);
    } else {
      if (String(r.status || '') === 'skipped') continue;
      sh = Number(r.shares || 0);
      amt = Number(r.amount || 0);
    }
    if (String(r.side) === 'buy') {
      cash -= amt;
      units += sh;
    } else {
      cash += amt;
      units -= sh;
    }
  }
  return { cash: Math.round(cash * 100) / 100, units: Math.max(units, 0) };
}

/**
 * 一条腿的逐日净值：closes 为该 ETF 自起步日起的收盘序列（升序），记账行按 exec_date 当天生效。
 * 返回 [{date, nav, bench}]；nav = 现金 + 份额×收盘。
 */
export function navSeries(
  principal: number,
  rows: ExecRow[],
  closes: { date: string; close: number }[]
): { date: string; nav: number; bench: number }[] {
  const sorted = [...rows].sort((a, b) =>
    a.exec_date === b.exec_date
      ? String(a.signal_date).localeCompare(String(b.signal_date))
      : String(a.exec_date).localeCompare(String(b.exec_date))
  );
  const out: { date: string; nav: number; bench: number }[] = [];
  let i = 0;
  const applied: ExecRow[] = [];
  for (const c of closes) {
    while (i < sorted.length && String(sorted[i].exec_date) <= c.date) {
      applied.push(sorted[i]);
      i += 1;
    }
    const a = stateFromRows(principal, applied, false);
    const b = stateFromRows(principal, applied, true);
    out.push({
      date: c.date,
      nav: Math.round((a.cash + a.units * c.close) * 100) / 100,
      bench: Math.round((b.cash + b.units * c.close) * 100) / 100,
    });
  }
  return out;
}

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
  const days = openDays.filter(d => d >= today).sort();
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
  price: number | null | undefined
): {
  shares: number;
  amount: number;
  skipped: boolean;
  reason: string;
  text: string;
  cashAfter: number;
  unitsAfter: number;
} {
  const { shares, amount } = sizeOrder(sig.side, sig.frac, cash, units, price);
  const name = ETF_NAME[sig.etf] || sig.etf;
  const pct = `${Math.round(sig.frac * 100)}%`;
  if (price == null || !(price > 0)) {
    return {
      shares: 0,
      amount: 0,
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
      skipped: false,
      reason: '',
      text: `${name} 买入 ${fmtMoney(amount)}，约 ${shares.toLocaleString(
        'zh-CN'
      )} 份`,
      cashAfter: cash - amount,
      unitsAfter: units + shares,
    };
  }
  return {
    shares,
    amount,
    skipped: false,
    reason: '',
    text: `${name} 卖出 ${shares.toLocaleString('zh-CN')} 份，约 ${fmtMoney(
      amount
    )}`,
    cashAfter: cash + amount,
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
