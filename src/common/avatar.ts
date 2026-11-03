import { createHash } from 'crypto';

/**
 * 用户头像（Agent Journey / Invest Journey 共用 user 表的 avatar 列）。
 *
 * avatar 列只允许三种值：
 *   - 'default'（或空）：前端按 avatarSeed 稳定生成一枚默认头像；
 *   - 预设标识（小写字母数字短横线，≤32）：前端按该标识生成同风格的预设头像（老的 cat/dog 等也走这里）；
 *   - 本站 OSS 上的上传头像 URL（avatars/ 前缀）。
 * 其余一律拒收——避免把任意外链/data: 写进库后在别人页面上渲染。
 */
export const OSS_PUBLIC_BASE =
  'https://font-end-journey-resources.oss-cn-hangzhou.aliyuncs.com';
export const AVATAR_PREFIX = 'avatars/';
/** 裁剪后的成品上限（前端压到 256px，正常 20~60KB） */
export const AVATAR_MAX_BYTES = 512 * 1024;
/** 每人每天上传次数上限 */
export const AVATAR_DAILY_UPLOADS = 20;

const PRESET_RE = /^[a-z0-9-]{1,32}$/;

export function isAllowedAvatar(v: string): boolean {
  if (v === '' || v === 'default') return true;
  if (PRESET_RE.test(v)) return true;
  const prefix = `${OSS_PUBLIC_BASE}/${AVATAR_PREFIX}`;
  return v.startsWith(prefix) && /^[a-z0-9/._-]+$/i.test(v.slice(prefix.length)) && !v.includes('..');
}

/** 默认头像的稳定种子：只用库内自增 id，不暴露手机号 */
export function avatarSeedOf(user: { id?: string | number } | null | undefined): string {
  return user?.id !== undefined && user?.id !== null ? `u${user.id}` : 'journey';
}

/** 按文件头识别图片类型；只认 PNG / JPEG / WebP */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

/** 解析前端传来的 base64（可带 data:image/...;base64, 前缀） */
export function decodeAvatarPayload(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw) throw new Error('没有收到图片');
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  // base64 → 字节约 3/4，先粗筛防止超大字符串解码
  if (b64.length > Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 16) throw new Error('图片太大了，请换一张或裁小一点');
  return Buffer.from(b64, 'base64');
}

export function avatarObjectKey(userId: string, buf: Buffer, ext: string): string {
  const owner = createHash('sha1').update(`avatar:${userId}`).digest('hex').slice(0, 16);
  const digest = createHash('md5').update(buf).digest('hex').slice(0, 16);
  return `${AVATAR_PREFIX}${owner}/${digest}.${ext}`;
}
