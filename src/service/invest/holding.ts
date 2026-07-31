import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';
import { deriveSnapshotRow, SnapshotRowInput } from './calc';

/** 持仓：当前持仓 CRUD、每日快照录入/编辑（服务端重算账户快照）、历史序列。 */
@Provide()
export class InvestHoldingService {
  @Inject()
  db: InvestDbService;

  /** 当前持仓 + 名称/行业 + 最新收盘估算浮盈亏。 */
  async current() {
    const holds = await this.db.q(
      `SELECT h.code, h.shares, h.cost_price, h.entry_date, h.updated_at,
              si.name, si.industry
       FROM current_holding h
       LEFT JOIN stock_info si ON si.ts_code = h.code
       ORDER BY h.code`
    );
    if (!holds.length) return [];
    const codes = holds.map(h => h.code);
    const ph = codes.map(() => '?').join(',');
    const px = await this.db.q(
      `SELECT sd.code, sd.close, sd.pct_chg, sd.trade_date
       FROM stock_daily sd
       JOIN (SELECT code, MAX(trade_date) td FROM stock_daily
             WHERE code IN (${ph}) GROUP BY code) mx
         ON mx.code = sd.code AND mx.td = sd.trade_date`,
      codes
    );
    const pxMap = new Map(px.map(p => [p.code, p]));
    // 快照里的名称兜底（ETF/转债不在 stock_info）
    const snapNames = await this.db.q(
      `SELECT code, name FROM holding_snapshot WHERE code IN (${ph})
       GROUP BY code, name`,
      codes
    );
    const nameMap = new Map(snapNames.map(n => [n.code, n.name]));
    return holds.map(h => {
      const p = pxMap.get(h.code);
      const close = p?.close ?? null;
      const mv = close != null ? h.shares * close : null;
      const pnl = close != null ? (close - h.cost_price) * h.shares : null;
      return {
        ...h,
        name: h.name || nameMap.get(h.code) || h.code,
        last_price: close,
        last_date: p?.trade_date ?? null,
        pct_chg: p?.pct_chg ?? null,
        market_value: mv,
        pnl,
        pnl_pct: close != null && h.cost_price > 0 ? (close / h.cost_price - 1) * 100 : null,
      };
    });
  }

  async upsertCurrent(row: { code: string; shares: number; cost_price: number; entry_date?: string }) {
    const sql = this.db.upsertSql(
      'current_holding',
      ['code', 'shares', 'cost_price', 'entry_date'],
      ['code']
    );
    await this.db.exec(sql, [row.code, row.shares, row.cost_price, row.entry_date || null]);
    return { code: row.code };
  }

  async deleteCurrent(code: string) {
    await this.db.exec('DELETE FROM current_holding WHERE code = ?', [code]);
    return { code };
  }

  async snapshotDates(): Promise<string[]> {
    const rows = await this.db.q(
      'SELECT DISTINCT snapshot_date FROM holding_snapshot ORDER BY snapshot_date DESC'
    );
    return rows.map(r => r.snapshot_date);
  }

  async snapshot(date?: string) {
    const d =
      date ||
      (await this.db.one('SELECT MAX(snapshot_date) d FROM holding_snapshot'))?.d;
    if (!d) return { date: null, rows: [], account: null };
    const rows = await this.db.q(
      `SELECT snapshot_date, code, name, asset_type, shares, available, cost_price,
              last_price, market_value, pnl, pnl_pct
       FROM holding_snapshot WHERE snapshot_date = ? ORDER BY market_value DESC`,
      [d]
    );
    const account = await this.db.one(
      'SELECT snapshot_date, cash, market_value, total_asset FROM account_snapshot WHERE snapshot_date = ?',
      [d]
    );
    return { date: d, rows, account };
  }

  /**
   * 批量录入/覆盖某日快照（等价 ingest_holding_snapshot.py）：
   * 当日先删后插 → 刷新 current_holding(stock+etf 全量替换) → 重算 account_snapshot。
   * 全程一个事务，保证净值曲线一致性。
   */
  async saveSnapshot(input: { snapshot_date: string; cash: number; rows: SnapshotRowInput[] }) {
    const { snapshot_date, cash } = input;
    const rows = (input.rows || []).map(deriveSnapshotRow);
    const mv = rows.reduce((s, r) => s + (r.market_value || 0), 0);
    await this.db.tx(async qr => {
      await qr.query('DELETE FROM holding_snapshot WHERE snapshot_date = ?', [snapshot_date]);
      const cols = ['snapshot_date', 'code', 'name', 'asset_type', 'shares', 'available',
        'cost_price', 'last_price', 'market_value', 'pnl', 'pnl_pct'];
      const insSql = this.db.upsertSql('holding_snapshot', cols, ['snapshot_date', 'code']);
      for (const r of rows) {
        await qr.query(insSql, [snapshot_date, r.code, r.name || '', r.asset_type,
          r.shares ?? null, r.available ?? null, r.cost_price ?? null, r.last_price ?? null,
          r.market_value, r.pnl, r.pnl_pct]);
      }
      // current_holding：stock+etf 全量替换（排除现金/转债，与 Python 端一致）
      const pos = rows.filter(r => ['stock', 'etf'].includes((r.asset_type || '').toLowerCase()));
      if (pos.length) {
        // 行数断言：现存持仓远多于本次载荷（>3倍+5）时判定为残缺快照，中止而非清表。
        // 全量替换语义只在载荷完整时才安全；事务内抛错整体回滚。
        const [{ n: existing }] = await qr.query(
          'SELECT COUNT(*) AS n FROM current_holding');
        if (Number(existing) > pos.length * 3 + 5) {
          throw new Error(
            `快照持仓行数异常：现存 ${existing} 行 vs 本次 ${pos.length} 行，疑似残缺载荷，已中止全量替换`);
        }
        await qr.query('DELETE FROM current_holding');
        const chSql = this.db.upsertSql(
          'current_holding', ['code', 'shares', 'cost_price', 'entry_date'], ['code']);
        for (const r of pos) {
          await qr.query(chSql, [r.code, r.shares ?? null, r.cost_price ?? null,
            r.entry_date || snapshot_date]);
        }
      }
      const acctSql = this.db.upsertSql(
        'account_snapshot', ['snapshot_date', 'cash', 'market_value', 'total_asset'],
        ['snapshot_date']);
      await qr.query(acctSql, [snapshot_date, Math.round(cash * 100) / 100,
        Math.round(mv * 100) / 100, Math.round((mv + cash) * 100) / 100]);
    });
    return { snapshot_date, rows: rows.length, market_value: mv, total_asset: mv + cash };
  }

  /** 删除快照单行并按剩余行+原现金重算账户快照。 */
  async deleteSnapshotRow(snapshot_date: string, code: string) {
    await this.db.tx(async qr => {
      await qr.query(
        'DELETE FROM holding_snapshot WHERE snapshot_date = ? AND code = ?',
        [snapshot_date, code]
      );
      const [sum] = await qr.query(
        'SELECT COALESCE(SUM(market_value),0) mv FROM holding_snapshot WHERE snapshot_date = ?',
        [snapshot_date]
      );
      const [acct] = await qr.query(
        'SELECT cash FROM account_snapshot WHERE snapshot_date = ?', [snapshot_date]);
      const cash = acct?.cash ?? 0;
      const acctSql = this.db.upsertSql(
        'account_snapshot', ['snapshot_date', 'cash', 'market_value', 'total_asset'],
        ['snapshot_date']);
      await qr.query(acctSql, [snapshot_date, cash, sum.mv, sum.mv + cash]);
    });
    return { snapshot_date, code };
  }

  /** 单标的持仓时序（市值/盈亏随时间）。 */
  async history(code: string, start?: string, end?: string) {
    const where = ['code = ?'];
    const params: any[] = [code];
    if (start) { where.push('snapshot_date >= ?'); params.push(start); }
    if (end) { where.push('snapshot_date <= ?'); params.push(end); }
    return this.db.q(
      `SELECT snapshot_date, shares, cost_price, last_price, market_value, pnl, pnl_pct
       FROM holding_snapshot WHERE ${where.join(' AND ')} ORDER BY snapshot_date`,
      params
    );
  }

  /** 全部持仓的按日市值（持仓变化堆叠图）。 */
  async positionSeries(start?: string, end?: string) {
    const where: string[] = ["asset_type != 'cash'"];
    const params: any[] = [];
    if (start) { where.push('snapshot_date >= ?'); params.push(start); }
    if (end) { where.push('snapshot_date <= ?'); params.push(end); }
    return this.db.q(
      `SELECT snapshot_date, code, name, market_value, pnl_pct
       FROM holding_snapshot WHERE ${where.join(' AND ')}
       ORDER BY snapshot_date, market_value DESC`,
      params
    );
  }

  /** 账户净值曲线。 */
  async accountSeries(start?: string, end?: string) {
    const where: string[] = [];
    const params: any[] = [];
    if (start) { where.push('snapshot_date >= ?'); params.push(start); }
    if (end) { where.push('snapshot_date <= ?'); params.push(end); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.q(
      `SELECT snapshot_date, cash, market_value, total_asset
       FROM account_snapshot ${w} ORDER BY snapshot_date`,
      params
    );
  }
}
