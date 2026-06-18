import * as OSS from 'ali-oss';
import { articlePath } from './modules';

/** OSS bucket 名称 */
const BUCKET = process.env.OSS_BUCKET || 'font-end-journey-resources';
/** OSS 所在地域 */
const REGION = process.env.OSS_REGION || 'oss-cn-hangzhou';

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

/** 懒初始化 OSS 客户端 */
function createOssClient(): OSS {
  return new OSS({
    region: REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
    bucket: BUCKET,
  });
}

export class OssService {
  private client: OSS;

  constructor() {
    this.client = createOssClient();
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
    const objKey = this.objectKey(module, filePath, key);
    await this.client.put(objKey, Buffer.from(content, 'utf-8'), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    });
  }

  /** 从 OSS 读取文件内容 */
  async get(module: string, filePath: string, key: string): Promise<string> {
    const objKey = this.objectKey(module, filePath, key);
    const result = await this.client.get(objKey);
    return result.content.toString('utf-8');
  }

  /** 删除 OSS 对象 */
  async delete(module: string, filePath: string, key: string): Promise<void> {
    const objKey = this.objectKey(module, filePath, key);
    await this.client.delete(objKey);
  }

  /** 将图片字节写入 OSS */
  async putImage(fileName: string, buf: Buffer): Promise<string> {
    const objKey = `images/${fileName}`;
    await this.client.put(objKey, buf);
    return objKey;
  }
}
