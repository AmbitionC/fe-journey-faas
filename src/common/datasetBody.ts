import { gzipSync } from 'zlib';

/**
 * 前端数据集接口的响应体（2026-10-27）：宽基历史回测 broadIndex.json 约 320KB，
 * 原先放前端仓静态文件、靠人工从 invest-model 字节复制，曾漏同步 7 周。现由 invest-model
 * broad-export 周更写入 invest.web_dataset，本服务原样下发。
 *
 * FC 不会自动压缩，320KB 明文比 Vercel 静态文件（brotli ≈ 88KB）重得多 ⟹ 这里预先
 * gzip（≈ 98KB），客户端声明支持时直接发压缩体。payload 在写库时已校验为合法 JSON，
 * 这里只拼信封、不再解析（省一次 320KB 的 parse/stringify）。
 */
export interface DatasetBody {
  raw: Buffer;
  gz: Buffer;
}

export function buildDatasetBody(payload: string): DatasetBody {
  const raw = Buffer.from(`{"success":true,"data":${payload}}`, 'utf8');
  return { raw, gz: gzipSync(raw) };
}

export function acceptsGzip(acceptEncoding?: string | null): boolean {
  return /(^|[\s,])gzip([\s;,]|$)/i.test(String(acceptEncoding || ''));
}
