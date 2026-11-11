import * as assert from 'assert';
import {
  emptyState,
  mergeState,
  sanitizeState,
} from '../src/service/practice/state';

describe('备考库做题记录 校验与合并', () => {
  const ans = (choice: string, correct: boolean, at: number) => ({
    choice,
    correct,
    at,
  });

  it('任何坏输入都得到空状态', () => {
    for (const bad of [null, 1, 'x', [], { practice: [] }]) {
      assert.deepStrictEqual(sanitizeState(bad), emptyState());
    }
  });

  it('丢掉坏题号、坏选项和多余字段', () => {
    const s = sanitizeState({
      userId: 'x',
      practice: {
        'soe-paper-1': {
          A01: { ...ans('B', true, 10), extra: 1 },
          '../x': ans('A', true, 10),
          A02: ans('Z', true, 10),
          A03: ans('A', true, 0),
        },
        'bad key!': { A01: ans('A', true, 10) },
      },
    });
    assert.deepStrictEqual(s.practice, {
      'soe-paper-1': { A01: ans('B', true, 10) },
    });
  });

  it('练习：同一题取后做的那次', () => {
    const a = sanitizeState({ practice: { p: { A01: ans('A', false, 10) } } });
    const b = sanitizeState({
      practice: { p: { A01: ans('B', true, 20), A02: ans('C', false, 5) } },
    });
    const want = { p: { A01: ans('B', true, 20), A02: ans('C', false, 5) } };
    assert.deepStrictEqual(mergeState(a, b).practice, want);
    assert.deepStrictEqual(mergeState(b, a).practice, want);
  });

  it('练习：清空重做之后，另一台设备更早的作答不会回来', () => {
    const a = sanitizeState({ cleared: { p: 100 } });
    const b = sanitizeState({
      practice: { p: { A01: ans('A', false, 50), A02: ans('B', true, 150) } },
    });
    const m = mergeState(a, b);
    assert.deepStrictEqual(m.practice, { p: { A02: ans('B', true, 150) } });
    assert.strictEqual(m.cleared.p, 100);
  });

  it('模考：取更新时间新的；一样新取已交卷的', () => {
    const exam = (updatedAt: number, submittedAt?: number) => ({
      answers: { A01: 'A' },
      flags: [],
      current: 0,
      elapsedMs: 1000,
      updatedAt,
      ...(submittedAt ? { submittedAt } : {}),
    });
    const a = sanitizeState({ exams: { p: exam(10, 10) } });
    const b = sanitizeState({ exams: { p: exam(20) } });
    assert.strictEqual(mergeState(a, b).exams.p.updatedAt, 20);
    const c = sanitizeState({ exams: { p: exam(20, 20) } });
    assert.strictEqual(mergeState(b, c).exams.p.submittedAt, 20);
    assert.strictEqual(mergeState(c, b).exams.p.submittedAt, 20);
  });

  it('错题本：移出的题不会被另一台设备的旧记录带回来', () => {
    const entry = (updatedAt: number, removedAt?: number) => ({
      articleKey: 'p',
      id: 'A01',
      choice: 'A',
      addedAt: 5,
      streak: 0,
      updatedAt,
      ...(removedAt ? { removedAt } : {}),
    });
    const stale = sanitizeState({ wrong: { 'p#A01': entry(10) } });
    const removed = sanitizeState({ wrong: { 'p#A01': entry(30, 30) } });
    assert.strictEqual(mergeState(stale, removed).wrong['p#A01'].removedAt, 30);
    assert.strictEqual(mergeState(removed, stale).wrong['p#A01'].removedAt, 30);
    // 移出之后又做错：新记录更新，重新收进来
    const again = sanitizeState({ wrong: { 'p#A01': entry(40) } });
    assert.strictEqual(
      mergeState(removed, again).wrong['p#A01'].removedAt,
      undefined
    );
  });

  it('错题本的键按文章和题号重算，不信客户端给的键', () => {
    const s = sanitizeState({
      wrong: {
        whatever: {
          articleKey: 'p',
          id: 'A01',
          choice: '',
          addedAt: 5,
          streak: 1,
        },
      },
    });
    assert.deepStrictEqual(Object.keys(s.wrong), ['p#A01']);
    assert.strictEqual(s.wrong['p#A01'].updatedAt, 5);
  });
});
