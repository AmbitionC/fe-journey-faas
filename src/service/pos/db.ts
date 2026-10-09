import { Provide, Config, Scope, ScopeEnum } from '@midwayjs/core';
import { DataSource } from 'typeorm';

/**
 * pos 库访问基座：Personal OS 个人上下文库。
 *
 * 解耦原则（与 health / invest 同一模式）：
 * - 独立数据库（默认 `pos`，同 RDS 实例），不注册进 @midwayjs/typeorm 全局数据源，
 *   库不可达只影响 /pos/* 请求，不殃及主站。
 * - 惰性初始化 + 幂等建表；失败清空缓存允许下次重试。
 * - **不植入任何个人数据种子**：本仓库公开，财务/收入等个人数字只经前端录入落库。
 * - dateStrings：DATE/DATETIME 一律以字符串返回，避免 FC 实例时区把日期挪一天。
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class PosDbService {
  @Config('posDb')
  cfg: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };

  private dsPromise: Promise<DataSource> | null = null;

  private static readonly QUERY_TIMEOUT_MS = 6000;

  private baseOptions() {
    return {
      type: 'mysql' as const,
      host: this.cfg.host,
      port: this.cfg.port || 3306,
      username: this.cfg.username,
      password: this.cfg.password,
      charset: 'utf8mb4',
      synchronize: false,
      logging: false,
      entities: [],
      connectTimeout: 8000,
    };
  }

  private async ensureDatabase(): Promise<void> {
    const admin = new DataSource({
      ...this.baseOptions(),
      extra: { allowPublicKeyRetrieval: true },
    });
    try {
      await admin.initialize();
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${this.cfg.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } catch {
      /* 无建库权限或已存在 */
    } finally {
      try {
        if (admin.isInitialized) await admin.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  private ensure(): Promise<DataSource> {
    if (!this.dsPromise) {
      this.dsPromise = (async () => {
        await this.ensureDatabase();
        const ds = new DataSource({
          ...this.baseOptions(),
          database: this.cfg.database,
          extra: {
            decimalNumbers: true,
            dateStrings: true,
            allowPublicKeyRetrieval: true,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
          },
        });
        await ds.initialize();
        await ensurePosSchema(q => ds.query(q));
        return ds;
      })().catch(e => {
        this.dsPromise = null;
        throw new Error(`pos 数据库连接失败：${e?.message || e}`);
      });
    }
    return this.dsPromise;
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `pos 查询超时（${label} >${PosDbService.QUERY_TIMEOUT_MS}ms）`
            )
          ),
        PosDbService.QUERY_TIMEOUT_MS
      );
      p.then(
        v => {
          clearTimeout(timer);
          resolve(v);
        },
        e => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  private async reset(): Promise<void> {
    const pending = this.dsPromise;
    this.dsPromise = null;
    if (pending) {
      try {
        const ds = await pending;
        await ds.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  /** SELECT（失败重建连接池重试一次）。占位符用 ? */
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

  async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.q<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** DML：只加超时，不自动重试（避免重复写）。返回 mysql2 OkPacket。 */
  async exec(sql: string, params: any[] = []): Promise<any> {
    const ds = await this.ensure();
    return await this.withTimeout(ds.query(sql, params), 'exec');
  }
}

const TABLE_TAIL =
  'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const STAMPS = `created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

/**
 * 幂等建表。事实类型 fact_type 贯穿全部表：
 * measured 实测 / reported 自述 / imported 导入 / estimated 粗估 /
 * inferred AI 推断 / planned 计划 / derived 派生 / superseded 已更正。
 */
export async function ensurePosSchema(
  run: (sql: string) => Promise<any>
): Promise<void> {
  // 随手记（想法/担忧/计划/决定…原文），AI 整理结果只作「建议」，确认后才生成事件/目标
  await run(`CREATE TABLE IF NOT EXISTS pos_note (
      id INT AUTO_INCREMENT PRIMARY KEY,
      content TEXT NOT NULL,
      kind VARCHAR(16) NOT NULL DEFAULT 'note',
      domain VARCHAR(16) NULL,
      tags VARCHAR(255) NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'web',
      ai_visibility VARCHAR(24) NOT NULL DEFAULT 'ai_allowed',
      ai_status VARCHAR(16) NOT NULL DEFAULT 'pending',
      ai_suggestion TEXT NULL,
      captured_at DATETIME NOT NULL,
      archived TINYINT NOT NULL DEFAULT 0,
      ${STAMPS},
      KEY idx_note_captured (captured_at)
    ) ${TABLE_TAIL}`);

  // 人生事件：planned 与 done 严格区分；结转时可对账户产生余额变动
  await run(`CREATE TABLE IF NOT EXISTS pos_event (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      detail TEXT NULL,
      domain VARCHAR(16) NULL,
      event_type VARCHAR(24) NOT NULL DEFAULT 'other',
      status VARCHAR(12) NOT NULL DEFAULT 'done',
      planned_date DATE NULL,
      occurred_date DATE NULL,
      amount DECIMAL(16,2) NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
      data_json TEXT NULL,
      fact_type VARCHAR(16) NOT NULL DEFAULT 'reported',
      note_id INT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'web',
      ${STAMPS},
      KEY idx_event_dates (occurred_date, planned_date)
    ) ${TABLE_TAIL}`);

  // 手录账户（现金/银行/房贷…）。A 股/美股账户来自 invest 库，不在此表
  await run(`CREATE TABLE IF NOT EXISTS pos_account (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      kind VARCHAR(24) NOT NULL DEFAULT 'cash',
      side VARCHAR(12) NOT NULL DEFAULT 'asset',
      currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
      liquid TINYINT NOT NULL DEFAULT 1,
      investable TINYINT NOT NULL DEFAULT 0,
      include_networth TINYINT NOT NULL DEFAULT 1,
      meta_json TEXT NULL,
      note VARCHAR(255) NULL,
      sort INT NOT NULL DEFAULT 0,
      archived TINYINT NOT NULL DEFAULT 0,
      ${STAMPS}
    ) ${TABLE_TAIL}`);

  // 账户余额快照：按 (账户, 日期) 一条，历史不覆盖；支持区间（如「2–3 万」）
  await run(`CREATE TABLE IF NOT EXISTS pos_balance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      as_of DATE NOT NULL,
      amount DECIMAL(18,2) NOT NULL,
      amount_low DECIMAL(18,2) NULL,
      amount_high DECIMAL(18,2) NULL,
      fact_type VARCHAR(16) NOT NULL DEFAULT 'reported',
      source VARCHAR(32) NOT NULL DEFAULT 'web',
      note VARCHAR(255) NULL,
      ${STAMPS},
      UNIQUE KEY uk_balance (account_id, as_of)
    ) ${TABLE_TAIL}`);

  // 外部资金流（入金/出金），区分「净资产变化」与「投资收益」的前提
  await run(`CREATE TABLE IF NOT EXISTS pos_flow (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_key VARCHAR(32) NOT NULL,
      flow_date DATE NOT NULL,
      amount DECIMAL(18,2) NOT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
      kind VARCHAR(16) NOT NULL DEFAULT 'deposit',
      note VARCHAR(255) NULL,
      ${STAMPS},
      KEY idx_flow (account_key, flow_date)
    ) ${TABLE_TAIL}`);

  // 收入事件：主业工资/奖金/激励、其他收入（税前/税后必须标注）
  await run(`CREATE TABLE IF NOT EXISTS pos_income (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kind VARCHAR(16) NOT NULL DEFAULT 'salary',
      period VARCHAR(7) NOT NULL,
      received_date DATE NULL,
      amount DECIMAL(16,2) NOT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
      basis VARCHAR(8) NOT NULL DEFAULT 'unknown',
      fact_type VARCHAR(16) NOT NULL DEFAULT 'reported',
      note VARCHAR(255) NULL,
      ${STAMPS},
      KEY idx_income (period)
    ) ${TABLE_TAIL}`);

  // 手录指标（腰围/每周精力/手动汇率…），按 (key, 日期) 幂等
  await run(`CREATE TABLE IF NOT EXISTS pos_metric (
      id INT AUTO_INCREMENT PRIMARY KEY,
      metric_key VARCHAR(48) NOT NULL,
      observed_on DATE NOT NULL,
      value DECIMAL(18,4) NOT NULL,
      unit VARCHAR(16) NULL,
      fact_type VARCHAR(16) NOT NULL DEFAULT 'measured',
      source VARCHAR(32) NOT NULL DEFAULT 'web',
      note VARCHAR(255) NULL,
      ${STAMPS},
      UNIQUE KEY uk_metric (metric_key, observed_on)
    ) ${TABLE_TAIL}`);

  // 关于我：身份/价值/原则/偏好/约束/方向（可纠正、可设过期、可禁止 AI 引用）
  await run(`CREATE TABLE IF NOT EXISTS pos_fact (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category VARCHAR(16) NOT NULL DEFAULT 'identity',
      label VARCHAR(64) NOT NULL,
      content TEXT NOT NULL,
      fact_type VARCHAR(16) NOT NULL DEFAULT 'reported',
      status VARCHAR(12) NOT NULL DEFAULT 'active',
      ai_visibility VARCHAR(24) NOT NULL DEFAULT 'ai_allowed',
      valid_from DATE NULL,
      valid_to DATE NULL,
      ${STAMPS}
    ) ${TABLE_TAIL}`);

  await run(`CREATE TABLE IF NOT EXISTS pos_goal (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      domain VARCHAR(16) NULL,
      metric_key VARCHAR(48) NULL,
      baseline DECIMAL(18,4) NULL,
      target DECIMAL(18,4) NULL,
      unit VARCHAR(16) NULL,
      target_date DATE NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'active',
      why TEXT NULL,
      ${STAMPS}
    ) ${TABLE_TAIL}`);
}
