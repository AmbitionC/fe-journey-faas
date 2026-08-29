import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 红利指数股息率读数（/invest/broad 的 dv 字段）契约。
 *
 * 三条不变量：
 * 1. 读数-only：dv 块必须整体 fail-soft（表未建/无数据时 broad() 其余部分照常返回）；
 * 2. 窗口诚实：个股股息率底层数据 2025 年起才有值，分位窗口按表内实际起点（since）
 *    下发，代码与注释不得写死「近十年」（数据没有那么长）；
 * 3. 分位随数据下发（pct/since），前端不自行计算、不写死窗口文案。
 */
const read = (p: string) =>
  readFileSync(join(__dirname, '..', '..', p), 'utf8');

describe('红利股息率读数契约', () => {
  const insight = read('src/service/invest/insight.ts');
  const start = insight.indexOf('async broad()');
  const end = insight.indexOf('async fearLatest()');
  const broadBlock = insight.slice(start, end);

  it('dv 读数存在且指向 index_dv_daily / 000922.CSI', () => {
    assert.ok(broadBlock.includes('index_dv_daily'));
    assert.ok(broadBlock.includes('000922.CSI'));
  });

  it('dv 块 fail-soft（表未建不拖垮 broad 其余字段）', () => {
    const dvStart = broadBlock.indexOf('let dv = null');
    assert.ok(dvStart > 0, 'dv 初始化缺失');
    const dvBlock = broadBlock.slice(dvStart, broadBlock.indexOf('return { date, latest, ledger'));
    assert.ok(/catch/.test(dvBlock), 'dv 查询未包 try/catch');
  });

  it('窗口诚实：随数据下发 since/pct，不写死「近十年」', () => {
    assert.ok(broadBlock.includes('since'), '缺 since（窗口起点）字段');
    assert.ok(broadBlock.includes('pct'), '缺 pct（分位）字段');
    assert.ok(!broadBlock.includes('近十年'), 'dv 数据只有 2025 起，不得写死「近十年」窗口');
  });
});
