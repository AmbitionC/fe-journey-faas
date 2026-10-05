import * as assert from 'assert';
import { createHash } from 'node:crypto';

type SyncModule = typeof import('../src/service/content/sync');
const commit = 'ab'.repeat(20);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('固定提交的 GitHub 同步输入', () => {
  let sync: SyncModule;
  let calls: Array<{ url: string; accept: string }>;
  let bytes: Record<string, Buffer>;
  let truncated: boolean;
  let missing: boolean;

  before(() => {
    // Use the real Contents URL construction and byte validation with a bounded
    // in-memory transport; no network, credentials or OSS writes are exercised.
    const fetchPath = require.resolve('node-fetch');
    const syncPath = require.resolve('../src/service/content/sync');
    require(fetchPath);
    const oldFetch = require.cache[fetchPath].exports;
    const oldSync = require.cache[syncPath];
    const fakeFetch: any = async (url: string, options: any) => {
      calls.push({ url, accept: options.headers.Accept });
      const parsed = new URL(url);
      assert.strictEqual(parsed.searchParams.get('ref'), commit);
      const repoPath = decodeURIComponent(parsed.pathname.split('/contents/')[1]);
      const body = bytes[repoPath];
      if (missing || !body) return { status: 404, ok: false };
      if (options.headers.Accept === 'application/vnd.github.object+json') {
        return { status: 200, ok: true, json: async () => ({ size: body.length }) };
      }
      assert.strictEqual(options.headers.Accept, 'application/vnd.github.raw+json');
      return { status: 200, ok: true, buffer: async () => truncated ? body.subarray(0, body.length - 1) : body };
    };
    fakeFetch.default = fakeFetch;
    require.cache[fetchPath].exports = fakeFetch;
    delete require.cache[syncPath];
    try { sync = require(syncPath); }
    finally {
      require.cache[fetchPath].exports = oldFetch;
      if (oldSync) require.cache[syncPath] = oldSync;
      else delete require.cache[syncPath];
    }
  });

  beforeEach(() => { calls = []; bytes = {}; truncated = false; missing = false; });

  it('manifest、正文、大图、图片重同步清单共用 afterSha，并报告实际字节哈希', async () => {
    bytes = {
      'knowledge/_tree.json': Buffer.from(JSON.stringify([{ key: 'a', label: 'A', isLeaf: true, filePath: 'basics', quickRead: { text: '作者速读' } }])),
      'knowledge/basics/a.md': Buffer.from('真实中文正文\n'),
      'images/中文 图.png': Buffer.alloc(1_200_000, 7),
      '.codex/image-resync.txt': Buffer.from('images/中文 图.png\n'),
    };
    const io = sync.createPinnedGithubSyncIO(commit.toUpperCase());
    const saved: any[] = [], uploaded: Buffer[] = [], nav: any[] = [];
    const result = await sync.syncChanged([
      { path: 'knowledge/_tree.json', status: 'modified' },
      { path: 'knowledge/basics/a.md', status: 'added' },
      { path: '.codex/image-resync.txt', status: 'modified' },
    ], async (module, tree) => { nav.push({ module, tree }); }, {
      put: async (...args) => { saved.push(args); },
      delete: async () => { assert.fail('No delete expected'); },
      putImage: async (name, b) => { assert.strictEqual(name, '中文 图.png'); uploaded.push(b); return 'images/' + name; },
    }, io);
    assert.deepStrictEqual(result, { manifests: 1, articles: 1, images: 1, deleted: 0, errors: [] });
    assert.strictEqual(io.sourceCommit, commit);
    assert.strictEqual(nav[0].tree[0].quickRead.text, '作者速读');
    assert.strictEqual(saved[0][3], bytes['knowledge/basics/a.md'].toString('utf8'));
    assert.ok(uploaded[0].equals(bytes['images/中文 图.png']));
    assert.strictEqual(calls.length, 8);
    assert.ok(calls.every(c => new URL(c.url).searchParams.get('ref') === commit));
    assert.ok(calls.some(c => c.url.includes('%E4%B8%AD%E6%96%87%20%E5%9B%BE.png')));
    assert.deepStrictEqual(io.sourceInputs(), Object.entries(bytes).map(([path, b]) => ({ path, bytes: b.length, sha256: sha(b) })).sort((a, b) => a.path.localeCompare(b.path)));
  });

  it('拒绝不完整或非法提交，在请求之前失败', () => {
    for (const bad of ['', 'master', 'ab1234', 'x'.repeat(40), null, 123]) {
      assert.throws(() => sync.createPinnedGithubSyncIO(bad as any), /40/);
    }
    assert.strictEqual(calls.length, 0);
  });

  it('先校验整批路径，包括删除；末尾非法路径不能造成前面文件写入', async () => {
    let writes = 0;
    const oss = { put: async () => { writes++; }, delete: async () => { writes++; }, putImage: async () => { writes++; return ''; } };
    for (const path of ['/images/a.png', 'knowledge/../a.md', 'knowledge//a.md', 'images\\a.png', 'images/./a.png', 'images/a\0.png']) {
      await assert.rejects(sync.syncChanged([
        { path: 'knowledge/basics/a.md', status: 'modified' }, { path, status: 'removed' },
      ], async () => { writes++; }, oss, sync.createPinnedGithubSyncIO(commit)), /路径/);
    }
    assert.strictEqual(writes, 0); assert.strictEqual(calls.length, 0);
  });

  it('无效 UTF-8 正文不能上传，错误保留在现有 errors 字段', async () => {
    bytes['knowledge/basics/a.md'] = Buffer.from([0xff, 0xfe]); let writes = 0;
    const result = await sync.syncChanged([{ path: 'knowledge/basics/a.md', status: 'modified' }], async () => {}, {
      put: async () => { writes++; }, delete: async () => {}, putImage: async () => '',
    }, sync.createPinnedGithubSyncIO(commit));
    assert.strictEqual(writes, 0); assert.strictEqual(result.articles, 0);
    assert.strictEqual(result.errors.length, 1); assert.match(result.errors[0], /UTF-8/);
  });

  it('大图被截断时不上传', async () => {
    bytes['images/a.png'] = Buffer.alloc(1_200_000); truncated = true; let writes = 0;
    const result = await sync.syncChanged([{ path: 'images/a.png', status: 'added' }], async () => {}, {
      put: async () => {}, delete: async () => {}, putImage: async () => { writes++; return ''; },
    }, sync.createPinnedGithubSyncIO(commit));
    assert.strictEqual(writes, 0); assert.strictEqual(result.images, 0); assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /不完整/);
  });

  it('固定提交中不存在的图仍报告失败，不记成功', async () => {
    missing = true;
    const result = await sync.syncChanged([{ path: 'images/missing.png', status: 'added' }], async () => {}, {
      put: async () => {}, delete: async () => {}, putImage: async () => { assert.fail('No upload'); return ''; },
    }, sync.createPinnedGithubSyncIO(commit));
    assert.strictEqual(result.images, 0); assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /不存在/);
  });
});
