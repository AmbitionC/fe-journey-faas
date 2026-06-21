import * as assert from 'assert';
import {
  computeReviewDue,
  DEFAULT_REVIEW_RULE,
} from '../src/service/article/reviewSchedule';

const DAY = 86400000;
const NOW = 1_700_000_000_000;

describe('article/reviewSchedule.ts — 复习到期判定', () => {
  it('未读(reading)不参与复习调度', () => {
    const due = computeReviewDue(
      [{ articleKey: 'a', status: 'reading', mastery: 'review', lastReadAt: NOW - 100 * DAY }],
      NOW
    );
    assert.strictEqual(due.length, 0);
  });

  it('review 间隔 3 天：第 4 天到期', () => {
    const due = computeReviewDue(
      [{ articleKey: 'a', status: 'done', mastery: 'review', lastReadAt: NOW - 4 * DAY }],
      NOW
    );
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0].articleKey, 'a');
  });

  it('review 第 2 天未到期', () => {
    const due = computeReviewDue(
      [{ articleKey: 'a', status: 'done', mastery: 'review', lastReadAt: NOW - 2 * DAY }],
      NOW
    );
    assert.strictEqual(due.length, 0);
  });

  it('mastered 间隔 14 天', () => {
    const notYet = computeReviewDue(
      [{ articleKey: 'a', status: 'done', mastery: 'mastered', lastReadAt: NOW - 10 * DAY }],
      NOW
    );
    assert.strictEqual(notYet.length, 0);
    const due = computeReviewDue(
      [{ articleKey: 'a', status: 'done', mastery: 'mastered', lastReadAt: NOW - 15 * DAY }],
      NOW
    );
    assert.strictEqual(due.length, 1);
  });

  it('new/无掌握度当天即到期', () => {
    const due = computeReviewDue(
      [{ articleKey: 'a', status: 'done', lastReadAt: NOW - 1000 }],
      NOW
    );
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0].mastery, 'new');
  });

  it('按优先级排序：未掌握 > 待复习 > 已掌握', () => {
    const due = computeReviewDue(
      [
        { articleKey: 'mastered', status: 'done', mastery: 'mastered', lastReadAt: NOW - 20 * DAY },
        { articleKey: 'new', status: 'done', mastery: 'new', lastReadAt: NOW - 20 * DAY },
        { articleKey: 'review', status: 'done', mastery: 'review', lastReadAt: NOW - 20 * DAY },
      ],
      NOW
    );
    assert.deepStrictEqual(
      due.map((d) => d.articleKey),
      ['new', 'review', 'mastered']
    );
  });

  it('低分(<60)拉高优先级，并在 reason 体现', () => {
    const due = computeReviewDue(
      [{ articleKey: 'a', status: 'done', mastery: 'review', lastReadAt: NOW - 4 * DAY, lastScore: 40 }],
      NOW
    );
    assert.strictEqual(due[0].reason, '上次得分 40%');
    assert.ok(due[0].priority > 20);
  });

  it('自定义规则可覆盖默认间隔', () => {
    const due = computeReviewDue(
      [{ articleKey: 'a', status: 'done', mastery: 'review', lastReadAt: NOW - 1 * DAY }],
      NOW,
      { intervalDays: { ...DEFAULT_REVIEW_RULE.intervalDays, review: 0 } }
    );
    assert.strictEqual(due.length, 1);
  });
});
