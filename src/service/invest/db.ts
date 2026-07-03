import { Provide, Config, Scope, ScopeEnum } from '@midwayjs/core';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * invest 库访问基座：原生 SQL（表结构由 invest-model Python 端唯一拥有）。
 *
 * 惰性初始化：不注册进 @midwayjs/typeorm 全局数据源（那会在应用启动时强制连接，
 * invest 库不可达时拖垮整个函数，殃及登录/验证码等原有功能）。首次 /invest/*
 * 请求才建连；失败清空缓存允许下次重试，且只影响当次请求。
 * mysql2 已开 decimalNumbers，DECIMAL 直接是 number。
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class InvestDbService {
  @Config('investDb')
  cfg: { host: string; port: number; username: string; password: string; database: string };

  private dsPromise: Promise<DataSource> | null = null;

  private ensure(): Promise<DataSource> {
    if (!this.dsPromise) {
      const ds = new DataSource({
        type: 'mysql',
        host: this.cfg.host,
        port: this.cfg.port || 3306,
        username: this.cfg.username,
        password: this.cfg.password,
        database: this.cfg.database,
        charset: 'utf8mb4',
        synchronize: false,
        logging: false,
        entities: [],
        connectTimeout: 8000,
        // DECIMAL 直接返回 number（金额精度 <2^53 够用），省去逐字段转换
        extra: { decimalNumbers: true, allowPublicKeyRetrieval: true },
      });
      this.dsPromise = ds.initialize().catch((e) => {
        this.dsPromise = null; // 失败允许下次重试
        throw new Error(`invest 数据库连接失败：${e?.message || e}`);
      });
    }
    return this.dsPromise;
  }

  /** SELECT：返回行数组。占位符用 ? */
  async q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const ds = await this.ensure();
    return ds.query(sql, params);
  }

  /** 单行 SELECT（无结果返回 null）。 */
  async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.q<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** DML（INSERT/UPDATE/DELETE）。 */
  async exec(sql: string, params: any[] = []): Promise<void> {
    const ds = await this.ensure();
    await ds.query(sql, params);
  }

  /** 事务：回调内的写操作同生共死。 */
  async tx<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const ds = await this.ensure();
    const qr = ds.createQueryRunner();
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
