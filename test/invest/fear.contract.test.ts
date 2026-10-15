import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 恐慌读数 /invest/fear/latest 契约（2026-10-15 体检修复·先失败后通过）。
 *
 * 事故：盘中卡片把「最新一条收盘恐慌」标成「收盘 48」，而盘中它其实是**前一交易日**的收盘值
 * （owner：「今天大跌，恐慌值也就 48 吗」——当时盘中已 58）；收盘值 18:30 算出后，盘中 15:00
 * 快照与它同日，旧条件 >= 仍优先返回盘中近似值、官方收盘值反而退居小字。
 * 不变量：
 * 1. 盘中快照只在**严格晚于**最新收盘值的交易日时才替代（同日以收盘官方值为准）；
 * 2. 盘中返回体带 daily_date（收盘值所属交易日），前端据此标「昨收」，不得猜。
 */
const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

describe('恐慌读数契约', () => {
  const insight = read('src/service/invest/insight.ts');
  const start = insight.indexOf('async fearLatest()');
  const block = insight.slice(start, insight.indexOf('async fearSeries('));

  it('盘中只在严格更新的交易日替代收盘值', () => {
    assert.ok(/String\(intra\.trade_date\) > String\(daily\.trade_date\)/.test(block),
      '须用严格 >：同日收盘官方值已出时不得再返回盘中近似值');
    assert.ok(!/String\(intra\.trade_date\) >= String\(daily\.trade_date\)/.test(block), '不得使用 >=');
  });

  it('盘中返回体带收盘值所属交易日 daily_date', () => {
    assert.ok(/daily_date:\s*daily\.trade_date/.test(block), '缺 daily_date 字段');
  });
});
