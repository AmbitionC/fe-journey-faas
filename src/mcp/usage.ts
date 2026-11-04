import { createHash } from 'crypto';

/**
 * 工具调用的「怎么用」埋点（owner 2026-11-04：「看看付费用户是怎么用的，会员权益是否够用，
 * 是否有 bug，以及看看有没有什么新的机会」）。
 *
 * 只给 mcp_call_log 补「形状」，不记原文：
 * - 参数：内容标识类（模块、文章 key、指数代码、序列名、档位、日期……）原样记，方便看「大家在查什么」；
 *   数字类（条数、页大小）原样记；自由文本（搜索词 / 自然语言问题）先打码（手机号、邮箱、
 *   6 位以上数字串），**24 字以内的短关键词**才记，长句只记长度——短关键词是站内搜索词，
 *   能看出「高频但没覆盖」的需求；长句可能带个人情况，不落库。
 * - args_hash：参数整体的哈希（不可逆），只用来判断「同一参数短时间内重复调用」。
 * - 结果：返回文本长度、条数（能识别出列表时）、是否截断——条数 0 的搜索就是没覆盖的需求。
 * - 计费：这次是真扣、当天已付（历史序列）、免费工具、失败退点、还是管理员 Key。
 * - 错误归类：参数不对 / 没找到 / 超时 / 上游 / 其他。
 */

/** 内容标识类参数：原样记录（截 40 字） */
const ID_PARAMS = new Set([
  'module',
  'articleKey',
  'slug',
  'tier',
  'code',
  'name',
  'topic',
  'start',
  'end',
  'id',
]);
/** 数字类参数 */
const NUM_PARAMS = new Set(['limit', 'pageSize', 'topN', 'maxArticles']);
/** 自由文本参数 */
const TEXT_PARAMS = new Set(['query', 'keyword']);

export const SHORT_TEXT_MAX = 24;
const ARGS_MAX = 300;

/** 打码：手机号、邮箱、身份证/卡号类长数字。 */
export function maskText(s: string, digits = true): string {
  const t = s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机]');
  return digits ? t.replace(/\d{6,}/g, '[数字]') : t;
}

function normText(v: any): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 参数摘要（落 mcp_call_log.args）。返回 null＝没有参数。
 * 自由文本：短的记 `q`（打码后），长的只记 `qLen`；未知参数只记名字（`other`）。
 */
export function summarizeArgs(
  args: Record<string, any> | null | undefined
): Record<string, any> | null {
  if (!args || typeof args !== 'object') return null;
  const out: Record<string, any> = {};
  const other: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue;
    if (ID_PARAMS.has(k)) {
      out[k] =
        typeof v === 'number' ? v : maskText(String(v), false).slice(0, 40); // 日期、代码是数字串，不按长数字打码
    } else if (NUM_PARAMS.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (TEXT_PARAMS.has(k)) {
      const t = normText(v);
      if (!t) continue;
      if (t.length <= SHORT_TEXT_MAX) out.q = maskText(t);
      else out.qLen = t.length;
    } else if (/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) {
      other.push(k);
    }
  }
  if (other.length) out.other = other.slice(0, 5).join(',');
  return Object.keys(out).length ? out : null;
}

export function argsJson(summary: Record<string, any> | null): string | null {
  if (!summary) return null;
  const s = JSON.stringify(summary);
  return s.length <= ARGS_MAX ? s : s.slice(0, ARGS_MAX);
}

/** 参数整体哈希（16 位，不可逆）：判断同参数重复调用。 */
export function argsHash(args: Record<string, any> | null | undefined): string {
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object')
      return Object.keys(v)
        .sort()
        .reduce((o: any, k) => ((o[k] = norm(v[k])), o), {});
    return typeof v === 'string' ? normText(v) : v;
  };
  return createHash('sha256')
    .update(JSON.stringify(norm(args || {})))
    .digest('hex')
    .slice(0, 16);
}

const LIST_KEYS = [
  'items',
  'list',
  'results',
  'rows',
  'data',
  'series',
  'articles',
  'topics',
  'missions',
  'nodes',
];

/** 结果条数：顶层是数组，或常见的列表字段；识别不出返回 null。 */
export function countItems(data: any): number | null {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== 'object') return null;
  for (const k of LIST_KEYS) {
    if (Array.isArray(data[k])) return data[k].length;
  }
  return null;
}

export type ErrKind =
  | 'invalid_args'
  | 'not_found'
  | 'timeout'
  | 'upstream'
  | 'other';

/** 报错归类（看板按类聚合，比按原文聚合好读）。 */
export function errKind(error: string | undefined | null): ErrKind | null {
  if (!error) return null;
  const e = String(error);
  if (/^缺少必填参数|^参数 \S+ (应为|只能是)|格式应为|只能是|^需要 /.test(e))
    return 'invalid_args';
  if (/超时|timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(e))
    return 'timeout';
  if (/不存在|未找到|找不到|没有找到|not found|无此|未知/i.test(e))
    return 'not_found';
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|上游|暂不可用|5\d\d/i.test(
      e
    )
  )
    return 'upstream';
  return 'other';
}

/** 一次调用的计费口径（落 mcp_call_log.billing）。 */
export type BillingKind =
  | 'charged' // 真扣了点且成功
  | 'refunded' // 扣了点但失败，已退
  | 'day_pass' // 历史序列当天已付过，本次不扣
  | 'free_tool' // 免费工具（价格 0）
  | 'free_phase' // 公测免费期
  | 'admin'; // 管理员手发的 Key，不计点

/** MCP 客户端可能调到、但我们没实现的方法（看「客户端期待什么」）。 */
export const KNOWN_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'tools/call',
]);
