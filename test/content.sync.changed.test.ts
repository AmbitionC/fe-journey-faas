/**
 * 测试 sync.ts 中的 syncChanged 函数（纯路由逻辑，mock 掉网络/OSS 调用）
 *
 * 覆盖场景：
 * - firstclass 扁平文章 added/modified → oss.put
 * - firstclass 扁平文章 removed         → oss.delete + result.deleted++
 * - interview / knowledge 多级路径 added → oss.put
 * - manifest (_tree.json) → saveNavToDb 回调
 * - images/ added → oss.putImage（二进制）
 * - images/ removed → result.deleted++
 * - 不认识的路径（无模块前缀）→ 静默忽略
 * - 错误捕获：单条文件处理失败不阻断整批，收入 result.errors
 */
import * as assert from 'assert';
import {
  assertBufferSize,
  syncChanged,
  ChangedFile,
  SyncChangedIO,
} from '../src/service/content/sync';

// ---------------------------------------------------------------------------
// Mock 工厂
// ---------------------------------------------------------------------------

interface OssMock {
  puts: Array<{ m: string; fp: string; k: string; content: string }>;
  deletes: Array<{ m: string; fp: string; k: string }>;
  images: Array<{ name: string }>;
  put: (m: string, fp: string, k: string, c: string) => Promise<void>;
  delete: (m: string, fp: string, k: string) => Promise<void>;
  putImage: (name: string, buf: Buffer) => Promise<string>;
}

function makeOssMock(overrides?: Partial<Pick<OssMock, 'put' | 'delete' | 'putImage'>>): OssMock {
  const mock: OssMock = {
    puts: [],
    deletes: [],
    images: [],
    put: async (m, fp, k, c) => { mock.puts.push({ m, fp, k, content: c }); },
    delete: async (m, fp, k) => { mock.deletes.push({ m, fp, k }); },
    putImage: async (name, _buf) => { mock.images.push({ name }); return `images/${name}`; },
    ...overrides,
  };
  return mock;
}

interface NavDbMock {
  calls: Array<{ module: string; navData: any }>;
  saveNavToDb: (module: string, navData: any) => Promise<void>;
}

function makeNavDbMock(): NavDbMock {
  const mock: NavDbMock = {
    calls: [],
    saveNavToDb: async (module, navData) => { mock.calls.push({ module, navData }); },
  };
  return mock;
}

/**
 * 构建 mock IO：将 repoPath → text/buffer 的映射传入，
 * 模拟 GitHub raw/buffer 读取，无需真实网络请求。
 */
function makeIO(textMap: Record<string, string>, bufMap: Record<string, Buffer> = {}): SyncChangedIO {
  return {
    fetchText: async (repoPath: string) => {
      if (repoPath in textMap) return textMap[repoPath];
      throw new Error(`mock fetchText: 未找到 ${repoPath}`);
    },
    fetchBuffer: async (repoPath: string) => {
      if (repoPath in bufMap) return bufMap[repoPath];
      if (repoPath in textMap) return Buffer.from(textMap[repoPath]);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncChanged() — 路由逻辑', () => {

  it('GitHub 二进制文件大小一致 → 通过完整性校验', () => {
    assert.doesNotThrow(() => assertBufferSize('images/photo.png', 1_200_000, 1_200_000));
  });

  it('GitHub 二进制文件被截断 → 拒绝继续上传', () => {
    assert.throws(
      () => assertBufferSize('images/photo.png', 1_200_000, 786_432),
      /期望 1200000 bytes，实际 786432 bytes/
    );
  });

  // -------------------------------------------------------------------------
  // firstclass 扁平文章 added / modified
  // -------------------------------------------------------------------------
  it('firstclass 文章 added → oss.put(firstclass, \'\', key)', async () => {
    const io = makeIO({ 'class/course-intro.md': '# 课程简介\n内容' });
    const oss = makeOssMock();
    const nav = makeNavDbMock();
    const files: ChangedFile[] = [{ path: 'class/course-intro.md', status: 'added' }];

    const result = await syncChanged(files, nav.saveNavToDb, oss, io);

    assert.strictEqual(result.articles, 1);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.manifests, 0);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(oss.puts.length, 1);
    assert.deepStrictEqual(oss.puts[0], {
      m: 'firstclass',
      fp: '',
      k: 'course-intro',
      content: '# 课程简介\n内容',
    });
  });

  it('firstclass 文章 modified → oss.put 同样路径', async () => {
    const io = makeIO({ 'class/course-intro.md': '# 更新内容' });
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'class/course-intro.md', status: 'modified' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.articles, 1);
    assert.strictEqual(oss.puts[0].m, 'firstclass');
    assert.strictEqual(oss.puts[0].fp, '');
    assert.strictEqual(oss.puts[0].k, 'course-intro');
  });

  // -------------------------------------------------------------------------
  // firstclass 文章 removed
  // -------------------------------------------------------------------------
  it('firstclass 文章 removed → oss.delete + result.deleted++', async () => {
    const io = makeIO({});
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'class/course-intro.md', status: 'removed' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(result.articles, 0);
    assert.strictEqual(oss.deletes.length, 1);
    assert.deepStrictEqual(oss.deletes[0], { m: 'firstclass', fp: '', k: 'course-intro' });
  });

  // -------------------------------------------------------------------------
  // interview 多级路径
  // -------------------------------------------------------------------------
  it('interview 多级路径 added → oss.put(interview, filePath, key)', async () => {
    const io = makeIO({ 'interview/tencent/base/q1.md': '# 问题1' });
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'interview/tencent/base/q1.md', status: 'added' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.articles, 1);
    assert.deepStrictEqual(oss.puts[0], {
      m: 'interview',
      fp: 'tencent/base',
      k: 'q1',
      content: '# 问题1',
    });
  });

  it('interview 多级路径 removed → oss.delete', async () => {
    const io = makeIO({});
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'interview/tencent/base/q1.md', status: 'removed' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.deleted, 1);
    assert.deepStrictEqual(oss.deletes[0], { m: 'interview', fp: 'tencent/base', k: 'q1' });
  });

  // -------------------------------------------------------------------------
  // knowledge 模块
  // -------------------------------------------------------------------------
  it('knowledge 文章 modified → oss.put(knowledge, ...)', async () => {
    const io = makeIO({ 'knowledge/backend/nodejs/streams.md': '# Streams' });
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'knowledge/backend/nodejs/streams.md', status: 'modified' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.articles, 1);
    assert.strictEqual(oss.puts[0].m, 'knowledge');
    assert.strictEqual(oss.puts[0].fp, 'backend/nodejs');
    assert.strictEqual(oss.puts[0].k, 'streams');
  });

  // -------------------------------------------------------------------------
  // manifest (_tree.json)
  // -------------------------------------------------------------------------
  it('firstclass manifest → saveNavToDb(firstclass, navData)', async () => {
    const navData = [{ key: 'intro', label: '简介', isLeaf: true }];
    const io = makeIO({ 'class/_tree.json': JSON.stringify(navData) });
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'class/_tree.json', status: 'modified' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.manifests, 1);
    assert.strictEqual(nav.calls.length, 1);
    assert.strictEqual(nav.calls[0].module, 'firstclass');
    assert.deepStrictEqual(nav.calls[0].navData, navData);
  });

  it('interview manifest → saveNavToDb(interview, ...)', async () => {
    const navData = [{ key: 'tencent', label: '腾讯' }];
    const io = makeIO({ 'interview/_tree.json': JSON.stringify(navData) });
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'interview/_tree.json', status: 'added' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.manifests, 1);
    assert.strictEqual(nav.calls[0].module, 'interview');
  });

  // -------------------------------------------------------------------------
  // images
  // -------------------------------------------------------------------------
  it('images/ 文件 added → oss.putImage + result.images++', async () => {
    const buf = Buffer.from('\x89PNG...');
    const io: SyncChangedIO = {
      fetchText: async (_p) => { throw new Error('should not call fetchText for images'); },
      fetchBuffer: async (_p) => buf,
    };
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'images/photo.png', status: 'added' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.images, 1);
    assert.strictEqual(oss.images.length, 1);
    assert.strictEqual(oss.images[0].name, 'photo.png');
  });

  it('images/ 文件 removed → result.deleted++（无 OSS put）', async () => {
    const io = makeIO({});
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [{ path: 'images/old.png', status: 'removed' }],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(oss.images.length, 0);
    assert.strictEqual(oss.puts.length, 0);
  });

  // -------------------------------------------------------------------------
  // 不认识的路径 → 静默忽略
  // -------------------------------------------------------------------------
  it('未知路径 → 静默忽略，不计入任何计数', async () => {
    const io = makeIO({});
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [
        { path: 'README.md', status: 'modified' },
        { path: '.github/workflows/push.yml', status: 'added' },
        { path: 'unknown/module/foo.md', status: 'added' },
      ],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.articles, 0);
    assert.strictEqual(result.manifests, 0);
    assert.strictEqual(result.images, 0);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.errors.length, 0);
  });

  // -------------------------------------------------------------------------
  // 错误隔离：单条失败不阻断整批
  // -------------------------------------------------------------------------
  it('单条文件处理失败 → 收入 errors，不阻断其他文件', async () => {
    // 'class/fail.md' → oss.put 会抛错; 'class/ok.md' → 正常
    const io = makeIO({
      'class/fail.md': '# Fail',
      'class/ok.md': '# OK',
    });
    const oss = makeOssMock({
      put: async (m, fp, k, c) => {
        if (k === 'fail') throw new Error('OSS write error');
        oss.puts.push({ m, fp, k, content: c });
      },
    });
    const nav = makeNavDbMock();

    const result = await syncChanged(
      [
        { path: 'class/fail.md', status: 'added' },
        { path: 'class/ok.md', status: 'added' },
      ],
      nav.saveNavToDb, oss, io
    );

    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('class/fail.md'));
    assert.strictEqual(result.articles, 1); // ok.md succeeded
  });

  // -------------------------------------------------------------------------
  // 空文件列表
  // -------------------------------------------------------------------------
  it('空 files 列表 → 全零统计，无错误', async () => {
    const io = makeIO({});
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const result = await syncChanged([], nav.saveNavToDb, oss, io);

    assert.strictEqual(result.articles, 0);
    assert.strictEqual(result.manifests, 0);
    assert.strictEqual(result.images, 0);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.errors.length, 0);
  });

  // -------------------------------------------------------------------------
  // 混合批次：多模块 + manifest + image
  // -------------------------------------------------------------------------
  it('混合批次 → 各计数正确汇总', async () => {
    const io = makeIO({
      'class/a.md': '# A',
      'interview/tencent/base/b.md': '# B',
      'interview/_tree.json': '[]',
    }, {
      'images/pic.jpg': Buffer.from('binarydata'),
    });
    const oss = makeOssMock();
    const nav = makeNavDbMock();

    const files: ChangedFile[] = [
      { path: 'class/a.md', status: 'modified' },
      { path: 'interview/tencent/base/b.md', status: 'added' },
      { path: 'interview/_tree.json', status: 'modified' },
      { path: 'images/pic.jpg', status: 'added' },
      { path: 'class/old.md', status: 'removed' },
    ];

    const result = await syncChanged(files, nav.saveNavToDb, oss, io);

    assert.strictEqual(result.articles, 2);   // a.md + b.md
    assert.strictEqual(result.manifests, 1);  // interview/_tree.json
    assert.strictEqual(result.images, 1);     // pic.jpg
    assert.strictEqual(result.deleted, 1);    // old.md removed
    assert.strictEqual(result.errors.length, 0);
  });
});
