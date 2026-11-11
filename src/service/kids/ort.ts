/**
 * 栗栗学英语的牛津树书库：书的文件放在 OSS 私有目录 little-circle-web/ort/l<级>/<书号>/，
 * 网站每次打开书架或一本书，从这里拿 2 小时有效的签名地址。
 *
 * 这里只有纯函数（校验书号/文件名、拼对象 key、把书里的文件名换成签名地址），方便单测；
 * 真正去 OSS 读文件、签名在 function/kids.ts。
 */

export const ORT_PREFIX = 'little-circle-web/ort';
export const ORT_SIGN_SECONDS = 2 * 3600;

const BOOK_ID = /^ort-l([1-9])-(\d{2})$/;
/** 一本书里只有这三种文件：book.json、每页图 pNN.webp、每句音频 lNN.mp3 */
const BOOK_FILE = /^(book\.json|p\d{2,3}\.webp|l\d{2,3}\.mp3)$/;

export function ortBookId(raw: unknown): string | null {
  const id = typeof raw === 'string' ? raw.trim() : '';
  return BOOK_ID.test(id) ? id : null;
}

/** 书里某个文件的对象 key；书号或文件名不合法（含 ../、斜杠、别的扩展名）返回 null */
export function ortObjectKey(bookId: string, file: unknown): string | null {
  const m = BOOK_ID.exec(bookId);
  if (!m || typeof file !== 'string' || !BOOK_FILE.test(file)) return null;
  return `${ORT_PREFIX}/l${m[1]}/${bookId}/${file}`;
}

export const ORT_SHELF_KEY = `${ORT_PREFIX}/shelf.json`;

type Sign = (objectKey: string) => string;

interface OrtLine {
  audio?: string | null;
  [k: string]: unknown;
}
interface OrtPage {
  image?: string;
  lines?: OrtLine[];
  [k: string]: unknown;
}
export interface OrtBook {
  id?: string;
  cover?: string | null;
  pages?: OrtPage[];
  [k: string]: unknown;
}
export interface OrtShelfItem {
  id?: string;
  cover?: string | null;
  [k: string]: unknown;
}

/** 文件名换成签名地址；不合法的文件名换成 null（不给签） */
function signFile(bookId: string, file: unknown, sign: Sign): string | null {
  const key = ortObjectKey(bookId, file);
  return key ? sign(key) : null;
}

/** 把一本书里的封面、每页图、每句音频都换成签名地址 */
export function signOrtBook(
  bookId: string,
  book: OrtBook,
  sign: Sign
): OrtBook {
  return {
    ...book,
    id: bookId,
    cover: book.cover ? signFile(bookId, book.cover, sign) : null,
    pages: (book.pages || []).map(page => ({
      ...page,
      image: signFile(bookId, page.image, sign) || '',
      lines: (page.lines || []).map(line => ({
        ...line,
        audio: line.audio ? signFile(bookId, line.audio, sign) : null,
      })),
    })),
  };
}

/** 书目：只留书号合法的，封面换成签名地址 */
export function signOrtShelf(shelf: unknown, sign: Sign): OrtShelfItem[] {
  if (!Array.isArray(shelf)) return [];
  return shelf
    .filter((b: OrtShelfItem) => b && ortBookId(b.id))
    .map((b: OrtShelfItem) => ({
      ...b,
      cover: b.cover ? signFile(b.id as string, b.cover, sign) : null,
    }));
}

/** ali-oss 没开 secure 时签出 http 地址，https 网站里会被浏览器拦下 */
export const toHttps = (url: string) => url.replace(/^http:\/\//, 'https://');
