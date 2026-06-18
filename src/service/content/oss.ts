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
    await this.client!.put(objKey, buf);
    return objKey;
  }
}
