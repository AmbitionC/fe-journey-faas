import * as assert from 'assert';
import { OperationsService } from '../src/service/operations';
import { OperationsHTTPService } from '../src/function/operations';
import { OssService } from '../src/service/content/oss';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileOperationsRepository } from './operations.repo';

const input = {
  title: 'Synthetic draft',
  body: 'Example',
  platform: 'xiaohongshu',
  images: [],
};
function webpChunk(kind: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(kind, 0, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
function animatedWebp(frameData: Buffer): Buffer {
  const extended = Buffer.alloc(10);
  extended[0] = 2;
  const payload = Buffer.concat([
    Buffer.from('WEBP'),
    webpChunk('VP8X', extended),
    webpChunk('ANIM', Buffer.alloc(6)),
    webpChunk('ANMF', Buffer.concat([Buffer.alloc(16), frameData])),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
const tinyWebp = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  'base64'
);
function service() {
  const rows = new Map<string, any>();
  const copy = (value: any) =>
    value ? JSON.parse(JSON.stringify(value)) : value;
  const s = new OperationsService();
  s.model = {
    insert: async row => {
      rows.set(row.id, copy(row));
    },
    findOneBy: async ({ id }) => copy(rows.get(id)),
    update: async (where, row) => {
      if (rows.get(where.id)?.revision !== where.revision)
        return { affected: 0 };
      rows.set(where.id, copy(row));
      return { affected: 1 };
    },
    findAndCount: async () => [[...rows.values()], rows.size],
  } as any;
  s.ossService = {
    signedUrl: key => `https://example.com/signed/${key}`,
  } as any;
  return s;
}
describe('operations storage commands and authorization', () => {
  it('rejects a missing command id before consulting the repository', async () => {
    const s = service();
    s.model = {
      findOneBy: async () => {
        throw new Error('must not read arbitrary first row');
      },
    } as any;
    for (const id of [undefined, null, '', 'bad'])
      await assert.rejects(
        s.command(
          { id, revision: 1, type: 'status', status: 'archived' },
          'admin'
        ),
        (e: any) => e.status === 400
      );
  });
  it('rejects a stale save without modifying the newer version', async () => {
    const s = service();
    const doc = await s.create(input, 'admin');
    const current = await s.command(
      { id: doc.id, revision: 1, type: 'save', ...input, title: 'Newer' },
      'admin'
    );
    await assert.rejects(
      s.command(
        { id: doc.id, revision: 1, type: 'save', ...input, title: 'Old tab' },
        'admin'
      ),
      (e: any) => e.status === 409
    );
    assert.strictEqual((await s.get(doc.id)).title, 'Newer');
    assert.strictEqual(current.document.versions.length, 2);
  });
  it('atomic revision check allows only one concurrent save', async () => {
    const s = service();
    const doc = await s.create(input, 'admin');
    const results = await Promise.allSettled(
      [1, 2].map(i =>
        s.command(
          {
            id: doc.id,
            revision: 1,
            type: 'save',
            ...input,
            title: `Concurrent ${i}`,
          },
          'admin'
        )
      )
    );
    assert.strictEqual(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.strictEqual((await s.get(doc.id)).document.versions.length, 2);
  });
  it('all endpoints reject anonymous and normal users before accessing storage', async () => {
    for (const ctx of [{}, { userInfo: { userId: 'normal', role: 'user' } }]) {
      const api = new OperationsHTTPService();
      api.ctx = ctx as any;
      for (const name of [
        'list',
        'detail',
        'create',
        'command',
        'upload',
        'preview',
        'importContent',
      ])
        await assert.rejects(
          (api as any)[name]({}),
          (e: any) => e.status === 401
        );
    }
  });
  it('administrator token fallback works for the existing login transport', async () => {
    const api = new OperationsHTTPService();
    api.ctx = { header: { token: 'synthetic' } } as any;
    api.redisService = {
      get: async () => JSON.stringify({ userId: 'admin', role: 'admin' }),
    } as any;
    api.operationsService = service();
    assert.strictEqual((await api.create(input)).success, true);
  });
  it('upload failure cannot attach an image; private write verifies bytes before signing', async () => {
    const s = service();
    await assert.rejects(
      s.upload({
        name: 'a.svg',
        dataBase64: Buffer.from('<svg/>').toString('base64'),
      }),
      /PNG/
    );
    s.ossService = {
      putPrivate: async () => {
        throw new Error('upload failed');
      },
      signedUrl: () => {
        throw new Error('should not sign');
      },
    } as any;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64'
    );
    await assert.rejects(
      s.upload({ name: 'a.png', dataBase64: png.toString('base64') }),
      /upload failed/
    );
    const oss = new OssService();
    let signed = false;
    (oss as any).client = {
      put: async (_key, _buf, options) => {
        assert.strictEqual(options.headers['x-oss-object-acl'], 'private');
      },
      getObjectMeta: async () => ({
        res: { headers: { 'content-length': '1' } },
      }),
      signatureUrl: () => {
        signed = true;
      },
    };
    await assert.rejects(
      oss.putPrivate('operations/images/a.png', png, 'image/png'),
      /大小校验失败/
    );
    assert.strictEqual(signed, false);
  });
  it('accepts real synthetic PNG/JPG/WebP containers without changing their bytes', async () => {
    const s = service();
    const written: Buffer[] = [];
    s.ossService = {
      putPrivate: async (_key, bytes) => {
        written.push(bytes);
      },
      signedUrl: () => 'signed',
    } as any;
    const fixtures = [
      [
        'png',
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          'base64'
        ),
      ],
      [
        'jpg',
        readFileSync(join(__dirname, 'fixtures/operations-synthetic-6x8.jpg')),
      ],
      [
        'jpg',
        readFileSync(
          join(__dirname, 'fixtures/operations-synthetic-progressive.jpg')
        ),
      ],
      ['webp', tinyWebp],
      ['webp', animatedWebp(tinyWebp.subarray(12))],
    ] as [string, Buffer][];
    for (const [extension, bytes] of fixtures) {
      const result = await s.upload({
        name: `[SYNTHETIC] fixture.${extension}`,
        dataBase64: bytes.toString('base64'),
      });
      assert.ok(result.key.endsWith('.' + extension));
      assert.deepStrictEqual(written[written.length - 1], bytes);
    }
  });
  it('rejects truncated and corrupt image containers before writing OSS', async () => {
    const s = service();
    let writes = 0;
    s.ossService = {
      putPrivate: async () => {
        writes++;
      },
      signedUrl: () => 'signed',
    } as any;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64'
    );
    const corrupt = Buffer.from(png);
    corrupt[20] ^= 1;
    for (const bytes of [
      png.subarray(0, 40),
      corrupt,
      Buffer.from([255, 216, 255, 224]),
      Buffer.from('RIFFxxxxWEBPxxxx'),
    ]) {
      await assert.rejects(
        s.upload({
          name: 'synthetic-damaged.png',
          dataBase64: bytes.toString('base64'),
        }),
        /图片损坏/
      );
    }
    assert.strictEqual(writes, 0);
  });
  it('checks later JPEG scan segments and every animated WebP frame before OSS', async () => {
    const s = service();
    let writes = 0;
    s.ossService = {
      putPrivate: async () => {
        writes++;
      },
      signedUrl: () => 'signed',
    } as any;
    const progressive = readFileSync(
      join(__dirname, 'fixtures/operations-synthetic-progressive.jpg')
    );
    const corruptJpeg = Buffer.from(progressive);
    const scan = corruptJpeg.indexOf(Buffer.from([255, 218]));
    const laterTable = corruptJpeg.indexOf(Buffer.from([255, 196]), scan + 2);
    assert.ok(laterTable > scan);
    corruptJpeg.writeUInt16BE(65535, laterTable + 2);
    const oversizedFrameChunk = Buffer.from(tinyWebp.subarray(12));
    oversizedFrameChunk.writeUInt32LE(65535, 4);
    for (const bytes of [
      corruptJpeg,
      animatedWebp(Buffer.alloc(1)),
      animatedWebp(oversizedFrameChunk),
    ]) {
      await assert.rejects(
        s.upload({
          name: 'synthetic-damaged',
          dataBase64: bytes.toString('base64'),
        }),
        /图片损坏/
      );
    }
    assert.strictEqual(writes, 0);
  });
  it('retrying an import keeps one document and rejects changed material under the same key', async () => {
    const s = service();
    const bundle = {
      idempotencyKey: 'ef4d673a-763b-4a79-a1c0-7e31c15210d5',
      versions: [
        { ...input, status: 'needs_changes' },
        { ...input, title: 'New text', status: 'in_review' },
      ],
    };
    const first = await s.importContent(bundle, 'admin');
    const retry = await s.importContent(bundle, 'admin');
    assert.deepStrictEqual(first.document, retry.document);
    assert.strictEqual((await s.list({})).total, 1);
    await assert.rejects(
      s.importContent(
        { ...bundle, versions: [{ ...input, status: 'draft' }] },
        'admin'
      ),
      (e: any) => e.status === 409
    );
  });
  it('reloads saved versions, status, publication and blank metrics from durable local storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operations-test-'));
    const path = join(dir, 'rows.json');
    const connect = () => {
      const s = service();
      s.model = new FileOperationsRepository(path) as any;
      return s;
    };
    try {
      let s = connect();
      let doc = await s.create(input, 'admin');
      doc = await s.command(
        {
          id: doc.id,
          revision: doc.revision,
          type: 'status',
          status: 'ready',
          note: 'Ready internally',
        },
        'admin'
      );
      assert.strictEqual(
        (
          await connect().list({
            status: 'ready',
            platform: 'xiaohongshu',
            q: 'Synthetic',
          })
        ).total,
        1
      );
      assert.strictEqual(
        (await connect().list({ status: 'published' })).total,
        0
      );
      doc = await s.command(
        {
          id: doc.id,
          revision: doc.revision,
          type: 'publish',
          publishedAt: '2026-10-10T00:00:00.000Z',
          url: 'https://example.com/post',
        },
        'admin'
      );
      doc = await s.command(
        {
          id: doc.id,
          revision: doc.revision,
          type: 'review',
          publicationId: doc.document.publications[0].id,
          observedAt: '2026-10-10T00:00:00.000Z',
          likes: 0,
        },
        'admin'
      );
      doc = await s.command(
        {
          id: doc.id,
          revision: doc.revision,
          type: 'save',
          ...input,
          title: 'Later revision',
        },
        'admin'
      );
      s = connect();
      const loaded = await s.get(doc.id);
      assert.deepStrictEqual(loaded, doc);
      assert.strictEqual(loaded.document.reviews[0].metrics.views, null);
      assert.strictEqual(loaded.document.reviews[0].metrics.likes, 0);
      assert.strictEqual(loaded.document.versions[0].title, input.title);
      assert.strictEqual(
        loaded.document.publications[0].url,
        'https://example.com/post'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
