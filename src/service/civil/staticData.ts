import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { gunzipSync } from 'zlib';

/**
 * 考公职位表数据的国内副本（2026-11-11）。
 *
 * 职位筛选器的数据（约 4.4MB 明文 / 0.47MB 压缩）原本只放在前端仓 public/data/civil/，
 * 由 Vercel（新加坡节点）下发。大陆网络访问 Vercel 时常只有十几 KB/s，页面一直停在
 * 「正在加载职位表…」。这里把同一份文件预压缩后随函数代码一起部署到杭州 FC，前端优先从这里取。
 *
 * 前端仓是这份数据的源头（scripts/civil/build-*.py 生成）；这里只是镜像。
 * 前端请求时带上自己那份文件的 sha256 前 12 位（?v=），对不上就回 409，前端回退到 Vercel 原文件，
 * 所以镜像忘了更新最多是慢，不会给出旧数据。更新方法见 assets/civil/README.md。
 */
export const CIVIL_DATASETS = {
  positions: 'guokao-2027.json.gz',
  scores: 'guokao-scores.json.gz',
} as const;

export type CivilDatasetName = keyof typeof CIVIL_DATASETS;

export interface CivilDataset {
  gz: Buffer;
  raw: Buffer;
  /** 明文 sha256 前 12 位，与前端仓同名文件对得上才算同一份 */
  version: string;
}

export const ASSET_DIR = resolve(__dirname, '../../../assets/civil');

const cache = new Map<CivilDatasetName, CivilDataset>();

export function isCivilDatasetName(name: unknown): name is CivilDatasetName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(CIVIL_DATASETS, name);
}

export function versionOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/** 读一次后常驻内存（两份合计约 0.6MB 压缩体 + 5MB 明文） */
export function loadCivilDataset(name: CivilDatasetName, dir = ASSET_DIR): CivilDataset {
  const hit = dir === ASSET_DIR ? cache.get(name) : undefined;
  if (hit) return hit;
  const gz = readFileSync(resolve(dir, CIVIL_DATASETS[name]));
  const raw = gunzipSync(gz);
  const ds = { gz, raw, version: versionOf(raw) };
  if (dir === ASSET_DIR) cache.set(name, ds);
  return ds;
}
