import * as assert from 'assert';
import {
  imageContentType,
  md5Base64,
  OssService,
} from '../src/service/content/oss';

describe('OssService 图片完整性', () => {
  it('设置正确的图片类型与 MD5，并校验 OSS 对象大小', async () => {
    const buf = Buffer.from('complete image bytes');
    const calls: any[] = [];
    const service = new OssService();

    (service as any).client = {
      put: async (key: string, body: Buffer, options: any) => {
        calls.push({ key, body, options });
      },
      getObjectMeta: async () => ({
        res: { headers: { 'content-length': String(buf.length) } },
      }),
    };

    const objectKey = await service.putImage('diagram.png', buf);

    assert.strictEqual(objectKey, 'images/diagram.png');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].key, objectKey);
    assert.strictEqual(calls[0].body, buf);
    assert.deepStrictEqual(calls[0].options.headers, {
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline',
      'Content-MD5': md5Base64(buf),
    });
  });

  it('OSS 对象大小不一致 → 上传失败', async () => {
    const buf = Buffer.from('complete image bytes');
    const service = new OssService();

    (service as any).client = {
      put: async () => undefined,
      getObjectMeta: async () => ({
        res: { headers: { 'content-length': String(buf.length - 1) } },
      }),
    };

    await assert.rejects(
      () => service.putImage('diagram.png', buf),
      /OSS images\/diagram\.png 大小校验失败/
    );
  });

  it('识别常见图片 MIME 类型', () => {
    assert.strictEqual(imageContentType('x.PNG'), 'image/png');
    assert.strictEqual(imageContentType('x.webp'), 'image/webp');
    assert.strictEqual(imageContentType('x.svg'), 'image/svg+xml');
    assert.strictEqual(imageContentType('x.unknown'), 'application/octet-stream');
  });
});
