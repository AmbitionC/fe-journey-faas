import * as assert from 'assert';
import { InvestInsightService } from '../../src/service/invest/insight';

/**
 * 每日市场观察（topic=insight）是会员权益（owner 2026-11-05）：
 * 非会员的预警流里看得到标题、看不到正文（locked），会员看全文；跟车提醒非会员照旧不出现。
 */
describe('预警流：每日市场观察只给会员看正文', () => {
  const rows = [
    { alert_key: 'insight:20261105', topic: 'insight', title: '每日市场观察 · 11月5日', body: '正文', trade_date: '20261105', created_at: '2026-11-05 09:10:00' },
    { alert_key: 'digest:20261104', topic: 'daily', title: '每日收盘播报', body: '播报', trade_date: '20261104', created_at: '2026-11-04 18:51:02' },
  ];
  function svc(seen: string[]) {
    const s = new InvestInsightService();
    (s as any).db = { async q(sql: string) { seen.push(sql); return rows.map(r => ({ ...r })); } };
    return s;
  }

  it('非会员：insight 正文置空并标 locked，SQL 排除 signal', async () => {
    const seen: string[] = [];
    const out: any = await svc(seen).alertFeed(50, false);
    const ins = out.rows.find((r: any) => r.topic === 'insight');
    assert.strictEqual(ins.body, '');
    assert.strictEqual(ins.locked, true);
    assert.strictEqual(out.rows.find((r: any) => r.topic === 'daily').body, '播报');
    assert.match(seen[0], /topic <> 'signal'/);
  });

  it('会员：全文可见', async () => {
    const out: any = await svc([]).alertFeed(50, true);
    const ins = out.rows.find((r: any) => r.topic === 'insight');
    assert.strictEqual(ins.body, '正文');
    assert.ok(!ins.locked);
  });
});
