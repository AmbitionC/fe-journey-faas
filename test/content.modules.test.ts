/**
 * 测试 content 模块配置函数（src/service/content/modules.ts）
 * 以及 sync.ts 中的纯函数（parseArticlePath, isTreeManifest）
 */
import * as assert from 'assert';
import {
  articlePath,
  manifestPath,
  isFlat,
  repoDir,
  moduleOfPath,
  ALL_MODULES,
} from '../src/service/content/modules';
import {
  isTreeManifest,
  parseArticlePath,
} from '../src/service/content/sync';

describe('modules.ts — 核心工具函数', () => {
  // ------------------------------------------------------------------
  // articlePath
  // ------------------------------------------------------------------
  describe('articlePath()', () => {
    it('firstclass 扁平: class/{key}.md', () => {
      assert.strictEqual(
        articlePath('firstclass', '', 'course-overview'),
        'class/course-overview.md'
      );
    });

    it('firstclass 忽略 filePath 参数', () => {
      // 即使传入 filePath 也应返回扁平路径
      assert.strictEqual(
        articlePath('firstclass', 'some/path', 'course-overview'),
        'class/course-overview.md'
      );
    });

    it('interview 标准三层路径', () => {
      assert.strictEqual(
        articlePath('interview', 'tencent/base', 'tencent-base-1'),
        'interview/tencent/base/tencent-base-1.md'
      );
    });

    it('knowledge 标准三层路径', () => {
      assert.strictEqual(
        articlePath('knowledge', 'backend/nodejs', 'x'),
        'knowledge/backend/nodejs/x.md'
      );
    });
  });

  // ------------------------------------------------------------------
  // manifestPath
  // ------------------------------------------------------------------
  describe('manifestPath()', () => {
    it('firstclass → class/_tree.json', () => {
      assert.strictEqual(manifestPath('firstclass'), 'class/_tree.json');
    });

    it('interview → interview/_tree.json', () => {
      assert.strictEqual(manifestPath('interview'), 'interview/_tree.json');
    });

    it('knowledge → knowledge/_tree.json', () => {
      assert.strictEqual(manifestPath('knowledge'), 'knowledge/_tree.json');
    });
  });

  // ------------------------------------------------------------------
  // isFlat
  // ------------------------------------------------------------------
  describe('isFlat()', () => {
    it('firstclass 是扁平模块', () => {
      assert.strictEqual(isFlat('firstclass'), true);
    });

    it('interview 不是扁平模块', () => {
      assert.strictEqual(isFlat('interview'), false);
    });

    it('knowledge 不是扁平模块', () => {
      assert.strictEqual(isFlat('knowledge'), false);
    });
  });

  // ------------------------------------------------------------------
  // repoDir
  // ------------------------------------------------------------------
  describe('repoDir()', () => {
    it('firstclass → class', () => {
      assert.strictEqual(repoDir('firstclass'), 'class');
    });

    it('interview → interview', () => {
      assert.strictEqual(repoDir('interview'), 'interview');
    });

    it('未知模块 → 模块名本身', () => {
      assert.strictEqual(repoDir('unknown'), 'unknown');
    });
  });

  // ------------------------------------------------------------------
  // moduleOfPath
  // ------------------------------------------------------------------
  describe('moduleOfPath()', () => {
    it('class/... → firstclass', () => {
      assert.strictEqual(moduleOfPath('class/course-overview.md'), 'firstclass');
    });

    it('interview/... → interview', () => {
      assert.strictEqual(
        moduleOfPath('interview/tencent/base/tencent-base-1.md'),
        'interview'
      );
    });

    it('knowledge/... → knowledge', () => {
      assert.strictEqual(
        moduleOfPath('knowledge/backend/nodejs/x.md'),
        'knowledge'
      );
    });

    it('不匹配的路径 → null', () => {
      assert.strictEqual(moduleOfPath('images/foo.png'), null);
    });
  });

  // ------------------------------------------------------------------
  // ALL_MODULES
  // ------------------------------------------------------------------
  describe('ALL_MODULES', () => {
    it('包含三个模块', () => {
      assert.deepStrictEqual(
        ALL_MODULES.slice().sort(),
        ['firstclass', 'interview', 'knowledge']
      );
    });
  });
});

describe('sync.ts — 纯函数', () => {
  // ------------------------------------------------------------------
  // isTreeManifest
  // ------------------------------------------------------------------
  describe('isTreeManifest()', () => {
    it('class/_tree.json → true', () => {
      assert.strictEqual(isTreeManifest('class/_tree.json'), true);
    });

    it('interview/_tree.json → true', () => {
      assert.strictEqual(isTreeManifest('interview/_tree.json'), true);
    });

    it('knowledge/_tree.json → true', () => {
      assert.strictEqual(isTreeManifest('knowledge/_tree.json'), true);
    });

    it('class/course-overview.md → false', () => {
      assert.strictEqual(isTreeManifest('class/course-overview.md'), false);
    });

    it('interview/tencent/base/x.md → false', () => {
      assert.strictEqual(
        isTreeManifest('interview/tencent/base/x.md'),
        false
      );
    });
  });

  // ------------------------------------------------------------------
  // parseArticlePath
  // ------------------------------------------------------------------
  describe('parseArticlePath()', () => {
    it('firstclass 扁平: class/{key}.md', () => {
      const result = parseArticlePath('class/course-overview.md');
      assert.deepStrictEqual(result, {
        module: 'firstclass',
        filePath: '',
        key: 'course-overview',
      });
    });

    it('knowledge 三层路径', () => {
      const result = parseArticlePath('knowledge/backend/nodejs/x.md');
      assert.deepStrictEqual(result, {
        module: 'knowledge',
        filePath: 'backend/nodejs',
        key: 'x',
      });
    });

    it('interview 三层路径', () => {
      const result = parseArticlePath(
        'interview/tencent/base/tencent-base-1.md'
      );
      assert.deepStrictEqual(result, {
        module: 'interview',
        filePath: 'tencent/base',
        key: 'tencent-base-1',
      });
    });

    it('manifest 文件 → null', () => {
      assert.strictEqual(parseArticlePath('class/_tree.json'), null);
    });

    it('非 .md 文件 → null', () => {
      assert.strictEqual(parseArticlePath('class/course-overview.png'), null);
    });

    it('images 目录 → null', () => {
      assert.strictEqual(parseArticlePath('images/photo.md'), null);
    });

    it('不认识的模块 → null', () => {
      assert.strictEqual(parseArticlePath('unknown/foo/bar.md'), null);
    });

    it('普通模块缺少 filePath → null', () => {
      // interview/key.md（没有子路径）
      assert.strictEqual(parseArticlePath('interview/key.md'), null);
    });
  });
});
