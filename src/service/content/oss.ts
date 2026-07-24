import { Provide } from '@midwayjs/core';
import * as OSS from 'ali-oss';
import { createHash } from 'crypto';
import { articlePath } from './modules';

/** OSS bucket 名称 */
const BUCKET = process.env.OSS_BUCKET || 'font-end-journey-resources';
/** OSS 所在地域 */
const REGION = process.env.OSS_REGION || 'oss-cn-hangzhou';

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export function imageContentType(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  return IMAGE_CONTENT_TYPES[extension] || 'application/octet-stream';
}

export function md5Base64(buf: Buffer): string {
  return createHash('md5').update(buf).digest('base64');
}

/**
 * 构建 OSS 对象 key
 *
 * - 扁平模块(firstclass): `class/{key}.md`
 * - 普通模块(interview/knowledge): `{module}/{filePath}/{key}.md`
 */
export function buildObjectKey(
  module: string,
  filePath: string,
  key: string
): string {
  return articlePath(module, filePath, key);
}

@Provide()
export class OssService {
  private client: OSS | undefined;

  constructor() {
    const accessKeyId = process.env.OSS_ACCESS_KEY_ID || '';
    const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET || '';
    // 若 key 缺失则 client 保持 undefined，调用时会得到明确错误（I4）
    if (!accessKeyId || !accessKeySecret) return;
    // key 存在时初始化失败要抛出，以便运维及时发现配置问题（I4）
    this.client = new OSS({
      region: REGION,
      accessKeyId,
      accessKeySecret,
      bucket: BUCKET,
    });
  }

  /** I4: 入口守卫——client 未初始化时抛出可诊断错误 */
  private assertClient(): void {
    if (!this.client) {
      throw new Error('OSS 未配置：请检查 OSS_ACCESS_KEY_ID 等环境变量');
    }
  }

  /** 获取对象 key（与 buildObjectKey 保持一致） */
  objectKey(module: string, filePath: string, key: string): string {
    return buildObjectKey(module, filePath, key);
  }

  /** 将内容写入 OSS */
  async put(
    module: string,
    filePath: string,
    key: string,
    content: string
  ): Promise<void> {
    this.assertClient();
    const objKey = this.objectKey(module, filePath, key);
    await this.client!.put(objKey, Buffer.from(content, 'utf-8'), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    });
  }

  /** 从 OSS 读取文件内容 */
  async get(module: string, filePath: string, key: string): Promise<string> {
    this.assertClient();
    const objKey = this.objectKey(module, filePath, key);
    const result = await this.client!.get(objKey);
    return result.content.toString('utf-8');
  }

  /** 删除 OSS 对象 */
  async delete(module: string, filePath: string, key: string): Promise<void> {
    this.assertClient();
    const objKey = this.objectKey(module, filePath, key);
    await this.client!.delete(objKey);
  }

  /** 将图片字节写入 OSS */
  async putImage(fileName: string, buf: Buffer): Promise<string> {
    this.assertClient();
    const objKey = `images/${fileName}`;
    await this.client!.put(objKey, buf, {
      headers: {
        'Content-Type': imageContentType(fileName),
        'Content-Disposition': 'inline',
        'Content-MD5': md5Base64(buf),
      },
    });

    // PUT 成功不等于业务上的完整：再读取对象元数据，防止
    // Content-Length 错误或上游 Buffer 截断被当成成功发布。
    const metadata: any = await this.client!.getObjectMeta(objKey);
    const storedSize = Number(metadata?.res?.headers?.['content-length']);
    if (!Number.isSafeInteger(storedSize) || storedSize !== buf.length) {
      throw new Error(
        `OSS ${objKey} 大小校验失败: 期望 ${buf.length} bytes，实际 ${String(storedSize)} bytes`
      );
    }
    return objKey;
  }

  /**
   * 生成带失效期的临时下载签名 URL（防泄漏传播）。
   * 对象需为 private ACL，公网直链不可访问，只能通过本签名链接在 expires 秒内下载。
   * 传 filename 时以 attachment 方式下载（浏览器另存为该文件名，而非 inline 打开），
   * 便于批量下载；中文名走 RFC5987 编码。
   */
  signedUrl(objKey: string, expiresSec = 86400, filename?: string): string {
    this.assertClient();
    const options: any = { expires: expiresSec };
    if (filename) {
      const encoded = encodeURIComponent(filename);
      options.response = {
        'content-disposition': `attachment; filename="download.pdf"; filename*=UTF-8''${encoded}`,
      };
    }
    return this.client!.signatureUrl(objKey, options);
  }

  /** 以私有 ACL 写入任意对象（下载类资产，禁止公网直链，只能签名访问） */
  async putPrivate(
    objKey: string,
    buf: Buffer,
    contentType = 'application/octet-stream'
  ): Promise<number> {
    this.assertClient();
    await this.client!.put(objKey, buf, {
      headers: {
        'Content-Type': contentType,
        'x-oss-object-acl': 'private',
        'Content-MD5': md5Base64(buf),
      },
    });
    const metadata: any = await this.client!.getObjectMeta(objKey);
    const storedSize = Number(metadata?.res?.headers?.['content-length']);
    if (!Number.isSafeInteger(storedSize) || storedSize !== buf.length) {
      throw new Error(
        `OSS ${objKey} 大小校验失败: 期望 ${buf.length} bytes，实际 ${String(storedSize)} bytes`
      );
    }
    return buf.length;
  }

  /** 按完整 objKey 读取文本对象（如 manifest.json）；不存在返回 null */
  async getRawText(objKey: string): Promise<string | null> {
    this.assertClient();
    try {
      const result = await this.client!.get(objKey);
      return result.content.toString('utf-8');
    } catch {
      return null;
    }
  }

  /** 写入文本对象（如 manifest.json），可选私有 ACL */
  async putRawText(
    objKey: string,
    text: string,
    contentType = 'application/json; charset=utf-8',
    isPrivate = true
  ): Promise<void> {
    this.assertClient();
    await this.client!.put(objKey, Buffer.from(text, 'utf-8'), {
      headers: {
        'Content-Type': contentType,
        ...(isPrivate ? { 'x-oss-object-acl': 'private' } : {}),
      },
    });
  }

  /** 读取任意对象元信息（供群二维码过期提醒等）；对象不存在返回 null */
  async rawMeta(objKey: string): Promise<{ lastModified: string } | null> {
    this.assertClient();
    try {
      const metadata: any = await this.client!.getObjectMeta(objKey);
      const lm = metadata?.res?.headers?.['last-modified'] || '';
      return lm ? { lastModified: lm } : null;
    } catch {
      return null;
    }
  }
}
