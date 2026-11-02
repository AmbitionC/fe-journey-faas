import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { InvestPoolService } from '../../src/service/invest/pool';
import { LATEST_STOCK_DATE_SQL } from '../../src/service/invest/db';

/**
 * 2026-11-02 线上事故：标的池接口「标的池底座查询失败：invest 查询超时（>6000ms）」。
 * 根因＝裸 `SELECT MAX(trade_date) FROM stock_daily` 在 (code, trade_date) 主键上扫全表。
 * 约束：invest 服务层不得再对 stock_daily 做不带 code 条件的 MAX(trade_date)。
 */
describe('stock_daily 最新交易日不扫全表', () => {
  it('最新日 SQL 带 code 条件', () => {
    assert.match(LATEST_STOCK_DATE_SQL, /FROM stock_daily WHERE code IN \(/);
  });

  it('invest 服务层源码里没有裸 MAX(trade_date) FROM stock_daily', () => {
    const dir = path.join(__dirname, '../../src/service/invest');
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(src, /MAX\(trade_date\)\s+\w*\s*FROM stock_daily['"`]/, f);
    }
  });

  it('标的池取最新日走快速 SQL', async () => {
    const seen: string[] = [];
    const svc = new InvestPoolService();
    (svc as any).db = {
      async one(sql: string) { seen.push(sql); return sql === LATEST_STOCK_DATE_SQL ? { d: '20261102' } : null; },
      async q(sql: string) { seen.push(sql); return []; },
    };
    const out = await svc.pool();
    assert.strictEqual(out.date, '20261102');
    assert.ok(seen.includes(LATEST_STOCK_DATE_SQL));
  });
});
