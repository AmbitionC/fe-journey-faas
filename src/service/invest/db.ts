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

  /** 单条 SQL 的兜底超时（ms）。必须 < FC 平台超时，好让我们主动抛错并自愈，
   * 而不是被平台在 15s 静默杀掉、连接还烂在池子里下次接着挂。 */
  private static readonly QUERY_TIMEOUT_MS = 6000;

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
        // DECIMAL 直接返回 number（金额精度 <2^53 够用），省去逐字段转换。
        // enableKeepAlive：FC 请求间会冻结实例、RDS 侧会回收空闲连接，池里缓存的
        // 连接容易变成半死 socket；开 TCP keepAlive 让 mysql2 定期探活、及时剔除死连接。
        extra: {
          decimalNumbers: true,
          allowPublicKeyRetrieval: true,
          enableKeepAlive: true,
          keepAliveInitialDelay: 10000,
        },
      });
      this.dsPromise = ds.initialize().catch((e) => {
        this.dsPromise = null; // 失败允许下次重试
        throw new Error(`invest 数据库连接失败：${e?.message || e}`);
      });
    }
    return this.dsPromise;
  }

  /** 给 promise 套超时；超时后强制抛错（连接可能烂了，交给上层自愈）。 */
  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`invest 查询超时（${label} >${InvestDbService.QUERY_TIMEOUT_MS}ms）`)),
        InvestDbService.QUERY_TIMEOUT_MS,
      );
      p.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /** 丢弃当前连接池（下次 ensure 会重建）。半死连接自愈用。 */
  private async reset(): Promise<void> {
    const pending = this.dsPromise;
    this.dsPromise = null;
    if (pending) {
      try {
        const ds = await pending;
        await ds.destroy();
      } catch {
        /* 池子本就烂了，销毁失败无所谓 */
      }
    }
  }

  /** SELECT：返回行数组。占位符用 ?
   * 读是幂等的：一旦查询超时/连接层报错，重建连接池再试一次，
   * 把「FC 冻结后第一枪打在死连接上」的偶发挂起自愈掉。 */
  async q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    try {
      const ds = await this.ensure();
      return await this.withTimeout<T[]>(ds.query(sql, params), 'q');
    } catch {
      await this.reset();
      const ds = await this.ensure();
      return await this.withTimeout<T[]>(ds.query(sql, params), 'q(retry)');
    }
  }

  /** 单行 SELECT（无结果返回 null）。 */
  async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.q<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** DML（INSERT/UPDATE/DELETE）。写非幂等，只加超时、不自动重试（避免重复写）。 */
  async exec(sql: string, params: any[] = []): Promise<void> {
    const ds = await this.ensure();
    await this.withTimeout(ds.query(sql, params), 'exec');
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
