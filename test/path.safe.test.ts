import * as assert from 'assert';
import { assertSafeSegment, normalizeFilePath } from '../src/service/content/path';

describe('assertSafeSegment', () => {
  // --- 合法路径应通过 ---
  it('合法 filePath + key 通过', () => {
    assert.doesNotThrow(() => assertSafeSegment('tencent/base', 'tencent-base-1'));
  });
  it('单级 filePath 通过', () => {
    assert.doesNotThrow(() => assertSafeSegment('foo', 'bar'));
  });
  it('filePath 带横杠和点通过', () => {
    assert.doesNotThrow(() => assertSafeSegment('foo/bar-baz.v2', 'key_1'));
  });
  it('多级 filePath 通过', () => {
    assert.doesNotThrow(() => assertSafeSegment('a/b/c', 'myKey'));
  });

  // --- 空 filePath 合法（firstclass 扁平模块）---
  it('空 filePath 合法（firstclass 扁平模块）', () => {
    assert.doesNotThrow(() => assertSafeSegment('', 'course-overview'));
  });

  // --- filePath 含 .. 段应被拒 ---
  it('filePath 含 .. 被拒', () => {
    assert.throws(() => assertSafeSegment('../etc', 'key'), /非法路径/);
  });
  it('filePath 中间段为 .. 被拒', () => {
    assert.throws(() => assertSafeSegment('foo/../bar', 'key'), /非法路径/);
  });
  it('filePath 以 .. 结尾被拒', () => {
    assert.throws(() => assertSafeSegment('foo/..', 'key'), /非法路径/);
  });

  // --- 绝对路径（以 / 开头）被拒 ---
  it('filePath 以 / 开头被拒', () => {
    assert.throws(() => assertSafeSegment('/foo/bar', 'key'), /非法路径/);
  });

  // --- filePath 以 / 结尾被拒 ---
  it('filePath 以 / 结尾被拒', () => {
    assert.throws(() => assertSafeSegment('foo/bar/', 'key'), /非法路径/);
  });

  // --- key 含 / 被拒 ---
  it('key 含 / 被拒', () => {
    assert.throws(() => assertSafeSegment('foo/bar', 'key/sub'), /非法路径/);
  });

  // --- key 为 .. 被拒 ---
  it('key 为 .. 被拒', () => {
    assert.throws(() => assertSafeSegment('foo/bar', '..'), /非法路径/);
  });

  // --- key 含非法字符被拒 ---
  it('key 含空格被拒', () => {
    assert.throws(() => assertSafeSegment('foo', 'my key'), /非法路径/);
  });
  it('key 含 @ 被拒', () => {
    assert.throws(() => assertSafeSegment('foo', 'ke@y'), /非法路径/);
  });

  // --- filePath 含非法字符被拒 ---
  it('filePath 含空格被拒', () => {
    assert.throws(() => assertSafeSegment('foo bar', 'key'), /非法路径/);
  });
});

describe('normalizeFilePath', () => {
  it('去除首尾斜杠', () => {
    assert.strictEqual(normalizeFilePath('/foo/bar/'), 'foo/bar');
  });
  it('中间斜杠保留', () => {
    assert.strictEqual(normalizeFilePath('a/b/c'), 'a/b/c');
  });
  it('空串返回空串', () => {
    assert.strictEqual(normalizeFilePath(''), '');
  });
});
