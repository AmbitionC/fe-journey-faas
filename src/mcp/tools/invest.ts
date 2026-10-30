import { ToolDef, ToolError, ServerSpec } from '../protocol';
import { METHODOLOGY, INDICATORS } from '../methodology';

/**
 * Invest Journey 的 MCP 工具（第一版：只读读数 + 口径）。
 *
 * 分层（技术方案 L1~L5）：第一版只开 L2「加工后读数」与 L3「口径说明」。
 * 🔴 刻意不透出：买卖触发线 / 窗口状态（L4，涉及投资建议边界，待合规结论）、
 * 任何持仓/市值/成本（owner 个人数据）、个股投顾信号。
 * 白名单投影在本文件内完成——上游 service 返回的是管理端全量字段，绝不整行透传。
 */

export interface InvestDeps {
  fearLatest(): Promise<any>;
  fearSeries(start?: string, end?: string): Promise<any[]>;
  bias(): Promise<{ date: string | null; latest: any[]; history: any[] }>;
  broad(): Promise<{ date: string | null; latest: any[]; dv?: any }>;
  macro(name?: string): Promise<any>;
  usage(): Promise<any>;
}

export const DISCLAIMER = '数据与口径说明，仅供研究参考，不构成任何投资建议。';

/** 展示顺序全站统一：沪深300 → 红利 → 创业板 → 科创50（库里 leg 存中文名）。 */
const LEG_ORDER = ['沪深300', '红利', '创业板', '科创50'];
const LEG_INDEX: Record<string, string> = {
  沪深300: '沪深300（000300.SH）',
  红利: '中证红利（000922.CSI）',
  创业板: '创业板指（399006.SZ）',
  科创50: '科创50（000688.SH）',
};

const rankOf = (leg: string) =>
  LEG_ORDER.includes(leg) ? LEG_ORDER.indexOf(leg) : 99;
const num = (v: any) =>
  v === null || v === undefined || v === '' ? null : Number(v);

function ymd(v: any, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).replace(/-/g, '');
  if (!/^\d{8}$/.test(s)) throw new ToolError(`${field} 格式应为 YYYYMMDD`);
  return s;
}

/** 恐慌指数：只给分数、分档、五个分量，不给 raw 里的内部计数。 */
export function projectFear(row: any) {
  if (!row) return null;
  return {
    trade_date: String(row.trade_date),
    score: num(row.score),
    level: row.level,
    components: row.components || null,
    intraday: row.intraday === true,
    ...(row.intraday
      ? {
          snapshot_ts: row.snapshot_ts,
          last_close_score: num(row.daily_score),
          last_close_date: row.daily_date,
        }
      : {}),
  };
}

/** 宽基指数：只给价格与长期中枢（中位线）及偏离，不给买卖线/状态/持仓。 */
export function projectBroadLeg(r: any) {
  const close = num(r.close);
  const median = num(r.median);
  return {
    index: LEG_INDEX[r.leg] || r.leg,
    close,
    long_term_median: median,
    vs_median_pct:
      close && median ? Math.round((close / median - 1) * 10000) / 100 : null,
    data_date: r.data_date ? String(r.data_date) : String(r.trade_date),
  };
}

export function projectBias(r: any) {
  return {
    code: r.code,
    name: r.name,
    trade_date: String(r.trade_date),
    close: num(r.close),
    ma60: num(r.ma60),
    bias60_pct:
      r.bias60 === null || r.bias60 === undefined
        ? null
        : Math.round(Number(r.bias60) * 10000) / 100,
    rank_low: num(r.rank_low),
    rank_high: num(r.rank_high),
    window_days: num(r.win_days),
    data_date: r.data_date ? String(r.data_date) : null,
  };
}

/**
 * 常用宏观序列的中文名（序列名是 tushare 接口.列，不看口径文档猜不出含义）。
 * 只给有把握的列命名；没列出的照常返回，label 为空。
 */
export const MACRO_LABELS: Record<string, string> = {
  'cn_m.m0': 'M0 余额（亿元）',
  'cn_m.m0_yoy': 'M0 同比（%）',
  'cn_m.m1': 'M1 余额（亿元）',
  'cn_m.m1_yoy': 'M1 同比（%）',
  'cn_m.m1_mom': 'M1 环比（%）',
  'cn_m.m2': 'M2 余额（亿元）',
  'cn_m.m2_yoy': 'M2 同比（%）',
  'cn_m.m2_mom': 'M2 环比（%）',
  'cn_cpi.nt_yoy': '全国 CPI 同比（%）',
  'cn_cpi.nt_mom': '全国 CPI 环比（%）',
  'cn_cpi.town_yoy': '城市 CPI 同比（%）',
  'cn_cpi.cnt_yoy': '农村 CPI 同比（%）',
  'cn_ppi.ppi_yoy': 'PPI 同比（%）',
  'cn_ppi.ppi_mom': 'PPI 环比（%）',
  'cn_ppi.ppi_mp_yoy': 'PPI 生产资料同比（%）',
  'cn_ppi.ppi_cg_yoy': 'PPI 生活资料同比（%）',
  'cn_pmi.pmi010000': '制造业 PMI',
  'cn_pmi.pmi020100': '非制造业商务活动指数',
  'cn_pmi.pmi030000': '综合 PMI 产出指数',
  'cn_gdp.gdp': 'GDP 累计值（亿元）',
  'cn_gdp.gdp_yoy': 'GDP 累计同比（%）',
  'sf_month.inc_month': '社融增量 当月（亿元）',
  'sf_month.inc_cumval': '社融增量 年内累计（亿元）',
  'sf_month.stk_endval': '社融存量（万亿元）',
  'mofcom_sf.total': '社融增量 合计（商务部分项表，亿元）',
  'mofcom_sf.rmb_loan': '社融增量 人民币贷款（亿元）',
  'mofcom_sf.corp_bond': '社融增量 企业债券（亿元）',
  'mofcom_sf.equity': '社融增量 股票融资（亿元）',
  'shibor_lpr.1y': 'LPR 1 年期（%）',
  'shibor_lpr.5y': 'LPR 5 年期以上（%）',
  'em_treasury.cn2y': '中国 2 年期国债收益率（%）',
  'em_treasury.cn5y': '中国 5 年期国债收益率（%）',
  'em_treasury.cn10y': '中国 10 年期国债收益率（%）',
  'em_treasury.cn30y': '中国 30 年期国债收益率（%）',
  'em_treasury.cn10y_2y': '中国 10Y−2Y 国债利差（百分点）',
  'em_treasury.us2y': '美国 2 年期国债收益率（%）',
  'em_treasury.us5y': '美国 5 年期国债收益率（%）',
  'em_treasury.us10y': '美国 10 年期国债收益率（%）',
  'em_treasury.us30y': '美国 30 年期国债收益率（%）',
  'em_treasury.us10y_2y': '美国 10Y−2Y 国债利差（百分点）',
};

/** 按关键词（中文名或序列名的一部分，如「M2」「国债」「PMI」）找序列。 */
export function findMacroSeries(keyword: string): string[] {
  const k = keyword.toLowerCase().replace(/\s+/g, '');
  return Object.entries(MACRO_LABELS)
    .filter(
      ([s, l]) =>
        s.toLowerCase().includes(k) ||
        l.toLowerCase().replace(/\s+/g, '').includes(k)
    )
    .map(([s]) => s);
}

export const investTools: ToolDef<InvestDeps>[] = [
  {
    name: 'market_snapshot',
    title: 'A 股市场读数快照',
    description:
      '一次取当前 A 股市场的核心加工读数：恐慌指数（0-100，越高越恐慌）、四个宽基指数相对长期中枢的位置、' +
      '七个指数的 60 日乖离率及近十年排名、中证红利股息率与历史分位。每个数的算法用 methodology_get 查。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_a, d) => {
      const [fear, broad, bias] = await Promise.all([
        d.fearLatest().catch(() => null),
        d.broad().catch(() => ({ date: null, latest: [] as any[], dv: null })),
        d.bias().catch(() => ({
          date: null,
          latest: [] as any[],
          history: [] as any[],
        })),
      ]);
      const legs = [...(broad.latest || [])]
        .sort((a, b) => rankOf(a.leg) - rankOf(b.leg))
        .map(projectBroadLeg);
      const dv = broad.dv
        ? {
            index: '中证红利',
            trade_date: broad.dv.trade_date,
            dividend_yield_ttm: broad.dv.dv_ttm,
            percentile_since: broad.dv.since,
            percentile: broad.dv.pct,
          }
        : null;
      return {
        fear: projectFear(fear),
        broad_index_position: { date: broad.date, items: legs },
        bias60: {
          date: bias.date,
          items: (bias.latest || []).map(projectBias),
        },
        dividend_yield: dv,
        disclaimer: DISCLAIMER,
      };
    },
  },
  {
    name: 'fear_series',
    title: '恐慌指数历史序列',
    description:
      '取恐慌指数逐日序列（2005 年起），含五个分量。日期格式 YYYYMMDD；不传默认近一年。',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '起始日 YYYYMMDD' },
        end: { type: 'string', description: '截止日 YYYYMMDD' },
      },
    },
    handler: async (a, d) => {
      let start = ymd(a.start, 'start');
      const end = ymd(a.end, 'end');
      if (!start) {
        const t = new Date(Date.now() - 365 * 24 * 3600 * 1000);
        start = t.toISOString().slice(0, 10).replace(/-/g, '');
      }
      const rows = await d.fearSeries(start, end);
      return {
        start,
        end: end || null,
        rows: rows.map(r => ({
          trade_date: String(r.trade_date),
          score: num(r.score),
          level: r.level,
          components: r.components,
        })),
        disclaimer: DISCLAIMER,
      };
    },
  },
  {
    name: 'bias_series',
    title: '指数乖离率历史',
    description:
      '取七个指数的 60 日乖离率与近十年排名逐日序列（库内逐日记录 2026-08 起，更早的历史看 methodology_get(bias_rank)），可按指数代码过滤（如 000300.SH）。' +
      '注意：这是读数不是信号，历史验证显示它不适合作买卖依据，详见 methodology_get(bias_rank)。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '指数代码，不传返回全部' },
      },
    },
    handler: async (a, d) => {
      const b = await d.bias();
      const code = a.code ? String(a.code).toUpperCase() : null;
      const rows = (b.history || [])
        .filter(r => !code || String(r.code).toUpperCase() === code)
        .map(r => ({
          trade_date: String(r.trade_date),
          code: r.code,
          name: r.name,
          bias60_pct:
            r.bias60 == null
              ? null
              : Math.round(Number(r.bias60) * 10000) / 100,
          rank_low: num(r.rank_low),
          rank_high: num(r.rank_high),
        }));
      return { latest_date: b.date, rows, disclaimer: DISCLAIMER };
    },
  },
  {
    name: 'macro_series',
    title: '宏观数据',
    description:
      '宏观数据层（M1/M2/社融/CPI/PPI/PMI/GDP/LPR/中美国债收益率等）。' +
      '传 keyword（如「M2」「10 年期国债」「制造业 PMI」「社融」）返回匹配序列的最新值与中文名；' +
      '传 name（如 cn_m.m2_yoy）返回该序列历史；都不传返回全部序列最新值（带中文名的排前面）。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '中文名或序列名关键词，如 M2、国债、PMI',
        },
        name: { type: 'string', description: '序列名，如 cn_m.m2_yoy' },
      },
    },
    handler: async (a, d) => {
      if (a.name) {
        const name = String(a.name).slice(0, 128);
        const r = await d.macro(name);
        return {
          ...r,
          label: MACRO_LABELS[name] || null,
          disclaimer: DISCLAIMER,
        };
      }
      const r: any = await d.macro(undefined);
      let latest: any[] = (r.latest || []).map((x: any) => ({
        ...x,
        label: MACRO_LABELS[x.series] || null,
      }));
      if (a.keyword) {
        const want = new Set(findMacroSeries(String(a.keyword).slice(0, 40)));
        const kw = String(a.keyword).toLowerCase();
        latest = latest.filter(
          x => want.has(x.series) || x.series.toLowerCase().includes(kw)
        );
        if (!latest.length)
          return {
            latest,
            note: '没有匹配的序列。不传参数可列出全部序列；本数据层没有的指标请如实告诉用户。',
            disclaimer: DISCLAIMER,
          };
      } else {
        latest.sort((x, y) => Number(!x.label) - Number(!y.label));
      }
      return { latest, disclaimer: DISCLAIMER };
    },
  },
  {
    name: 'indicator_list',
    title: '指标清单',
    description:
      '列出本服务提供的全部指标：含义、更新频率、取数工具、对应口径文档。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ indicators: INDICATORS }),
  },
  {
    name: 'methodology_get',
    title: '口径与算法说明',
    description:
      '取某个指标的完整口径：数据来源、计算公式、参数、窗口、已知局限与历史验证结论。' +
      '让用户在自己的 Agent 里按自己的风险偏好复用或改造。',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', enum: Object.keys(METHODOLOGY) } },
      required: ['topic'],
    },
    handler: async a => {
      const m = METHODOLOGY[a.topic];
      if (!m)
        throw new ToolError(
          `未知主题，可选：${Object.keys(METHODOLOGY).join(' / ')}`
        );
      return { topic: a.topic, ...m };
    },
  },
  {
    name: 'account_usage',
    title: '今日用量',
    description: '查看当前 API Key 的今日调用次数与每日上限。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_a, d) => d.usage(),
  },
];

export const investServer: ServerSpec<InvestDeps> = {
  name: 'invest-journey',
  version: '0.1.0',
  instructions:
    'Invest Journey 数据服务：A 股市场加工读数（恐慌指数、宽基相对长期中枢位置、乖离率、股息率、宏观数据）与完整口径。' +
    '先 market_snapshot 看全貌，再按需取历史序列；解释任何数字前用 methodology_get 查口径。' +
    '所有数据仅供研究，不构成投资建议；不要把读数直接说成买卖指令，用户的仓位与风险偏好由用户自己决定。',
  tools: investTools,
};
