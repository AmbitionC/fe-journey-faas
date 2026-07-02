import { Provide, Inject } from '@midwayjs/core';
import { InvestDbService } from './db';

export interface RecoFilter {
  start?: string;
  end?: string;
  grade?: string;
  direction?: string;
  sourceType?: string;
  code?: string;
  activeOnly?: boolean;
  page?: number;
  pageSize?: number;
}

/** 投顾信号（个股 reco + 主题 theme）：筛选查询 + CRUD。 */
@Provide()
export class InvestAdvisorService {
  @Inject()
  db: InvestDbService;

  private today(): string {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    return bj.toISOString().slice(0, 10).replace(/-/g, '');
  }

  async listReco(f: RecoFilter) {
    const where: string[] = [];
    const params: any[] = [];
    if (f.activeOnly) {
      const d = this.today();
      where.push("rec_date <= ? AND (valid_until IS NULL OR valid_until = '' OR valid_until >= ?)");
      params.push(d, d);
    }
    if (f.start) { where.push('rec_date >= ?'); params.push(f.start); }
    if (f.end) { where.push('rec_date <= ?'); params.push(f.end); }
    if (f.grade) { where.push('grade = ?'); params.push(f.grade); }
    if (f.direction) { where.push('direction = ?'); params.push(f.direction); }
    if (f.sourceType) { where.push('source_type = ?'); params.push(f.sourceType); }
    if (f.code) { where.push('code = ?'); params.push(f.code); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    if (f.activeOnly) {
      // 同票多条取 rec_date 最新（等价 AdvisorRepo.get_active_reco 的 drop_duplicates）
      const rows = await this.db.q(
        `SELECT rec_date, code, source_type, grade, direction, catalyst, valid_until,
                source, raw_excerpt
         FROM advisor_reco ${w} ORDER BY rec_date DESC, source_type`,
        params
      );
      const seen = new Set<string>();
      const dedup = rows.filter(r => !seen.has(r.code) && seen.add(r.code) !== undefined);
      return { list: dedup, total: dedup.length };
    }
    const page = Math.max(1, f.page || 1);
    const pageSize = Math.min(200, f.pageSize || 50);
    const [cnt] = await this.db.q(
      `SELECT COUNT(*) n FROM advisor_reco ${w}`, params);
    const list = await this.db.q(
      `SELECT rec_date, code, source_type, grade, direction, catalyst, valid_until,
              source, raw_excerpt
       FROM advisor_reco ${w}
       ORDER BY rec_date DESC, code LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    // 名称补充
    const codes = [...new Set(list.map(r => r.code))];
    if (codes.length) {
      const ph = codes.map(() => '?').join(',');
      const names = await this.db.q(
        `SELECT ts_code, name FROM stock_info WHERE ts_code IN (${ph})`, codes);
      const nm = new Map(names.map(n => [n.ts_code, n.name]));
      list.forEach(r => (r.name = nm.get(r.code) || ''));
    }
    return { list, total: Number(cnt.n) };
  }

  async upsertReco(row: {
    rec_date: string; code: string; source_type: string; grade?: string;
    direction?: string; catalyst?: string; valid_until?: string; source?: string;
    raw_excerpt?: string;
  }) {
    const cols = ['rec_date', 'code', 'source_type', 'grade', 'direction', 'catalyst',
      'valid_until', 'source', 'raw_excerpt'];
    await this.db.exec(
      this.db.upsertSql('advisor_reco', cols, ['rec_date', 'code', 'source_type']),
      [row.rec_date, row.code, row.source_type, row.grade || null, row.direction || null,
        row.catalyst || null, row.valid_until || null, row.source || null,
        row.raw_excerpt || null]
    );
    return { rec_date: row.rec_date, code: row.code, source_type: row.source_type };
  }

  async deleteReco(pk: { rec_date: string; code: string; source_type: string }) {
    await this.db.exec(
      'DELETE FROM advisor_reco WHERE rec_date = ? AND code = ? AND source_type = ?',
      [pk.rec_date, pk.code, pk.source_type]
    );
    return pk;
  }

  async listTheme(f: RecoFilter) {
    const where: string[] = [];
    const params: any[] = [];
    if (f.activeOnly) {
      const d = this.today();
      where.push("rec_date <= ? AND (valid_until IS NULL OR valid_until = '' OR valid_until >= ?)");
      params.push(d, d);
    }
    if (f.start) { where.push('rec_date >= ?'); params.push(f.start); }
    if (f.end) { where.push('rec_date <= ?'); params.push(f.end); }
    if (f.direction) { where.push('direction = ?'); params.push(f.direction); }
    if (f.sourceType) { where.push('source_type = ?'); params.push(f.sourceType); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, f.page || 1);
    const pageSize = Math.min(200, f.pageSize || 50);
    const [cnt] = await this.db.q(`SELECT COUNT(*) n FROM advisor_theme ${w}`, params);
    const list = await this.db.q(
      `SELECT rec_date, theme, source_type, direction, thesis, valid_until
       FROM advisor_theme ${w} ORDER BY rec_date DESC, theme LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    return { list, total: Number(cnt.n) };
  }

  async upsertTheme(row: {
    rec_date: string; theme: string; source_type: string; direction?: string;
    thesis?: string; valid_until?: string;
  }) {
    const cols = ['rec_date', 'theme', 'source_type', 'direction', 'thesis', 'valid_until'];
    await this.db.exec(
      this.db.upsertSql('advisor_theme', cols, ['rec_date', 'theme', 'source_type']),
      [row.rec_date, row.theme, row.source_type, row.direction || null,
        row.thesis || null, row.valid_until || null]
    );
    return { rec_date: row.rec_date, theme: row.theme, source_type: row.source_type };
  }

  async deleteTheme(pk: { rec_date: string; theme: string; source_type: string }) {
    await this.db.exec(
      'DELETE FROM advisor_theme WHERE rec_date = ? AND theme = ? AND source_type = ?',
      [pk.rec_date, pk.theme, pk.source_type]
    );
    return pk;
  }
}
