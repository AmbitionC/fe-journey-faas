import { createHmac, randomUUID } from 'crypto';

/**
 * 阿里云 RPC 风格 OpenAPI 的最小调用器（签名 V1，HMAC-SHA1）。
 *
 * 只给号码认证服务（dypnsapi）两条接口用，故不引官方 SDK（多一串 @darabonba 依赖、
 * 换来的只是这 40 行）。签名算法见阿里云「RPC 风格签名」文档，
 * test/smsAuth.test.ts 用文档里的官方样例逐字核对。
 */

/** RFC3986 编码：在 encodeURIComponent 基础上再编 !'()*（~ 保留不编）。 */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** 按 V1 规则对参数签名（params 不含 Signature）。 */
export function signRpc(
  method: 'GET' | 'POST',
  params: Record<string, string>,
  accessKeySecret: string
): string {
  const canonical = Object.keys(params)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(
    canonical
  )}`;
  return createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
}

export interface RpcCall {
  endpoint: string; // 如 https://dypnsapi.aliyuncs.com/
  action: string;
  version: string;
  accessKeyId: string;
  accessKeySecret: string;
  params: Record<string, string | number | boolean | undefined>;
  fetchImpl?: (url: string, init: any) => Promise<any>;
  timeoutMs?: number;
}

/** 发起一次 RPC 调用，返回解析后的 JSON（含阿里云的 Code/Message；HTTP 非 2xx 也照样返回 JSON 体）。 */
export async function callRpc(c: RpcCall): Promise<any> {
  const params: Record<string, string> = {
    Action: c.action,
    Version: c.version,
    Format: 'JSON',
    AccessKeyId: c.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  for (const [k, v] of Object.entries(c.params)) {
    if (v !== undefined && v !== null && v !== '') params[k] = String(v);
  }
  const signature = signRpc('POST', params, c.accessKeySecret);
  const body = Object.keys(params)
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .concat(`Signature=${percentEncode(signature)}`)
    .join('&');
  const doFetch = c.fetchImpl || (globalThis as any).fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs ?? 8000);
  try {
    const res = await doFetch(c.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { Code: `HTTP_${res.status}`, Message: text.slice(0, 200) };
    }
  } finally {
    clearTimeout(timer);
  }
}
