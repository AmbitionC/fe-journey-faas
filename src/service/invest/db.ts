import { Provide } from '@midwayjs/core';
import { InjectDataSource } from '@midwayjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * invest 库访问基座：原生 SQL（表结构由 invest-model Python 端唯一拥有）。
 * mysql2 已开 decimalNumbers，DECIMAL 直接是 number。
 */
@Provide()
export class InvestDbService {
  @InjectDataSource('invest')
  ds: DataSource;

  /** SELECT：返回行数组。占位符用 ? */
  async q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.ds.query(sql, params);
  }

  /** 单行 SELECT（无结果返回 null）。 */
  async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.q<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** DML（INSERT/UPDATE/DELETE）。 */
  async exec(sql: string, params: any[] = []): Promise<void> {
    await this.ds.query(sql, params);
  }

  /** 事务：回调内的写操作同生共死。 */
  async tx<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const out = await fn(qr);
      await qr.commitTransaction();
      return out;
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  /** 生成 INSERT ... ON DUPLICATE KEY UPDATE（等价 Python BaseRepository.upsert）。 */
  upsertSql(table: string, cols: string[], uniqueKeys: string[]): string {
    const colList = cols.map(c => `\`${c}\``).join(', ');
    const ph = cols.map(() => '?').join(', ');
    const updates = cols
      .filter(c => !uniqueKeys.includes(c))
      .map(c => `\`${c}\`=VALUES(\`${c}\`)`)
      .join(', ');
    return `INSERT INTO \`${table}\` (${colList}) VALUES (${ph}) ON DUPLICATE KEY UPDATE ${updates}`;
  }
}
