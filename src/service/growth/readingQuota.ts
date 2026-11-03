/**
 * 「非会员每模块限看 N 篇」影响评估（2026-11-03，管理员只读）。
 *
 * 数据源 article_view_log：每次打开文章正文（ArticleActions → /article/view）记一行，
 * fingerprint 对登录用户是 userId（手机号），对游客是 md5(ip+ua) 的 32 位十六进制。
 * 这里只做纯计算：输入已按 (fingerprint, module[, month]) 聚合好的 distinct 篇数，
 * 输出分桶与「超过 N 篇」的人数，绝不输出任何 fingerprint / 手机号。
 */

export interface ReadingRow {
  fingerprint: string;
  module: string;
  articles: number;
  bot?: boolean;
}

export const READING_BUCKETS: Array<[string, number, number]> = [
  ['1', 1, 1],
  ['2-3', 2, 3],
  ['4-5', 4, 5],
  ['6-10', 6, 10],
  ['11-20', 11, 20],
  ['21+', 21, Infinity],
];

const GUEST_FP = /^[0-9a-f]{32}$/;
export const BOT_UA = /bot|spider|crawl|slurp|headless|lighthouse|python|curl|wget|okhttp|scrapy/i;

export function readerKind(fp: string): 'guest' | 'login' {
  return GUEST_FP.test(fp) ? 'guest' : 'login';
}

export interface ModuleSummary {
  module: string;
  kind: 'guest' | 'login';
  readers: number;
  buckets: Record<string, number>;
  overQuota: number;
  /** 超额的人在额度之外多看的篇数合计（即收紧后会被拦下的阅读量） */
  blockedReads: number;
  totalReads: number;
}

export function summarizeReading(
  rows: ReadingRow[],
  quota: number,
  skip: Set<string> = new Set()
): { list: ModuleSummary[]; bots: number } {
  const map = new Map<string, ModuleSummary>();
  let bots = 0;
  for (const r of rows) {
    if (r.bot) {
      bots += 1;
      continue;
    }
    if (skip.has(r.fingerprint)) continue;
    const n = Number(r.articles) || 0;
    if (n <= 0) continue;
    const kind = readerKind(r.fingerprint);
    const key = `${r.module}|${kind}`;
    let s = map.get(key);
    if (!s) {
      s = {
        module: r.module,
        kind,
        readers: 0,
        buckets: Object.fromEntries(READING_BUCKETS.map(([b]) => [b, 0])),
        overQuota: 0,
        blockedReads: 0,
        totalReads: 0,
      };
      map.set(key, s);
    }
    s.readers += 1;
    s.totalReads += n;
    const b = READING_BUCKETS.find(([, lo, hi]) => n >= lo && n <= hi);
    if (b) s.buckets[b[0]] += 1;
    if (n > quota) {
      s.overQuota += 1;
      s.blockedReads += n - quota;
    }
  }
  const list = Array.from(map.values()).sort(
    (a, b) => a.module.localeCompare(b.module) || a.kind.localeCompare(b.kind)
  );
  return { list, bots };
}
