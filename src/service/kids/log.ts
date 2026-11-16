/**
 * 栗栗学英语阅读器的播放问题日志：网页上 play() 被拒、音频出错、卡住时上报一条。
 * 只留白名单字段（事件名、浏览器标识、页面路径、书号、页码、错误名），不存个人信息；
 * 存 Redis 列表，最多留最近 2000 条。
 */
export const KIDS_LOG_KEY = 'kids:log';
export const KIDS_LOG_MAX = 2000;

const EV = /^[a-z_]{1,32}$/;

export interface KidsLogEntry {
  ev: string;
  ua: string;
  path: string;
  book?: string;
  page?: number;
  name?: string;
  code?: number;
  src?: string;
  paused?: boolean;
  rs?: number;
  t: number;
  ip?: string;
}

const str = (v: unknown, n: number) =>
  typeof v === 'string' ? v.slice(0, n) : undefined;

/** 不合法返回 null；body 可以是 JSON 字符串（网页用 sendBeacon 发 text/plain）或对象 */
export function sanitizeKidsLog(
  raw: unknown,
  now = Date.now()
): KidsLogEntry | null {
  let r: any = raw;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== 'object' || !EV.test(r.ev)) return null;
  const out: KidsLogEntry = {
    ev: r.ev,
    ua: str(r.ua, 200) || '',
    path: str(r.path, 80) || '',
    t: now,
  };
  const book = str(r.book, 20);
  if (book && /^[a-z0-9-]+$/i.test(book)) out.book = book;
  if (Number.isInteger(r.page) && r.page >= 0 && r.page < 500)
    out.page = r.page;
  const name = str(r.name, 40);
  if (name && /^[A-Za-z]+$/.test(name)) out.name = name;
  if (Number.isInteger(r.code) && r.code >= 0 && r.code < 10) out.code = r.code;
  const src = str(r.src, 40);
  if (src && /^[a-z0-9._-]+$/i.test(src)) out.src = src;
  if (typeof r.paused === 'boolean') out.paused = r.paused;
  if (Number.isInteger(r.rs) && r.rs >= 0 && r.rs <= 4) out.rs = r.rs;
  return out;
}
