import { Provide, Config, Scope, ScopeEnum } from '@midwayjs/core';
import { DataSource } from 'typeorm';

/**
 * health 库访问基座：个人健康管理模块（体成分/饮食/活动/预算）。
 *
 * 解耦原则（与 invest 模块同一模式）：
 * - 独立数据库（默认 `health`，同 RDS 实例），不注册进 @midwayjs/typeorm 全局
 *   数据源——避免启动时强制建连，库不可达只影响 /health/* 请求，不殃及主站。
 * - 惰性初始化：首次 /health/* 请求才建连；失败清空缓存允许下次重试。
 * - 表结构由本模块唯一拥有：首次建连后幂等执行 CREATE TABLE IF NOT EXISTS，
 *   并在空表时植入基线数据（2026-07-15 体成分 + 个人档案），无需手工初始化。
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class HealthDbService {
  @Config('healthDb')
  cfg: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };

  private dsPromise: Promise<DataSource> | null = null;

  /** 单条 SQL 兜底超时（ms），必须 < FC 平台超时，主动抛错自愈而非被平台静默杀。 */
  private static readonly QUERY_TIMEOUT_MS = 6000;

  /** 建库（幂等）。RDS 上 health 库可能不存在，用无库连接先创建；无权限时忽略
   * （由管理员手工建库后一样能跑通）。 */
  private async ensureDatabase(): Promise<void> {
    const admin = new DataSource({
      type: 'mysql',
      host: this.cfg.host,
      port: this.cfg.port || 3306,
      username: this.cfg.username,
      password: this.cfg.password,
      charset: 'utf8mb4',
      synchronize: false,
      logging: false,
      entities: [],
      connectTimeout: 8000,
      extra: { allowPublicKeyRetrieval: true },
    });
    try {
      await admin.initialize();
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${this.cfg.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } catch {
      /* 无建库权限或已存在，后续真实连接失败会再报错 */
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
          // decimalNumbers：DECIMAL 直接返回 number；
          // keepAlive：FC 冻结实例后 RDS 会回收空闲连接，探活剔除死连接。
          extra: {
            decimalNumbers: true,
            allowPublicKeyRetrieval: true,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
          },
        });
        await ds.initialize();
        await this.ensureSchema(ds);
        return ds;
      })().catch(e => {
        this.dsPromise = null; // 失败允许下次重试
        throw new Error(`health 数据库连接失败：${e?.message || e}`);
      });
    }
    return this.dsPromise;
  }

  /** 幂等建表 + 空表基线种子。JSON 字段用 TEXT 存（兼容低版本 MySQL）。 */
  private async ensureSchema(ds: DataSource): Promise<void> {
    await ds.query(`CREATE TABLE IF NOT EXISTS body_composition (
      id INT AUTO_INCREMENT PRIMARY KEY,
      record_date DATE NOT NULL,
      weight_kg DECIMAL(5,2) NOT NULL,
      bmi DECIMAL(4,2) NULL,
      body_fat_pct DECIMAL(4,1) NULL,
      body_fat_mass_kg DECIMAL(5,2) NULL,
      muscle_mass_kg DECIMAL(5,2) NULL,
      skeletal_muscle_mass_kg DECIMAL(5,2) NULL,
      visceral_fat_level DECIMAL(4,1) NULL,
      subcutaneous_fat_pct DECIMAL(4,1) NULL,
      protein_pct DECIMAL(4,1) NULL,
      water_pct DECIMAL(4,1) NULL,
      notes VARCHAR(512) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_body_date (record_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await ds.query(`CREATE TABLE IF NOT EXISTS meal_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      record_date DATE NOT NULL,
      meal_type VARCHAR(16) NOT NULL,
      meal_time VARCHAR(5) NULL,
      source VARCHAR(16) NOT NULL DEFAULT 'manual',
      items_json TEXT NULL,
      total_kcal INT NOT NULL DEFAULT 0,
      protein_g DECIMAL(6,1) NOT NULL DEFAULT 0,
      carbs_g DECIMAL(6,1) NOT NULL DEFAULT 0,
      fat_g DECIMAL(6,1) NOT NULL DEFAULT 0,
      notes VARCHAR(512) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_meal_date (record_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await ds.query(`CREATE TABLE IF NOT EXISTS activity_daily (
      id INT AUTO_INCREMENT PRIMARY KEY,
      record_date DATE NOT NULL,
      steps INT NULL,
      active_kcal INT NULL,
      resting_kcal INT NULL,
      exercise_minutes INT NULL,
      stand_hours INT NULL,
      workouts_json TEXT NULL,
      sleep_hours DECIMAL(4,2) NULL,
      weight_kg DECIMAL(5,2) NULL,
      raw_json TEXT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'ios-shortcut',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_activity_date (record_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await ds.query(`CREATE TABLE IF NOT EXISTS health_profile (
      id INT PRIMARY KEY,
      height_cm DECIMAL(5,1) NOT NULL,
      birth_year INT NOT NULL,
      sex VARCHAR(8) NOT NULL DEFAULT 'male',
      activity_factor DECIMAL(3,2) NOT NULL DEFAULT 1.25,
      deficit_kcal INT NOT NULL DEFAULT 400,
      protein_per_kg DECIMAL(3,2) NOT NULL DEFAULT 1.80,
      goal_weight_kg DECIMAL(5,2) NULL,
      goals_json TEXT NULL,
      preferences TEXT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // ---- 基线种子（幂等：仅空表写入）----
    const [{ c: bodyCount }] = await ds.query(
      'SELECT COUNT(*) AS c FROM body_composition'
    );
    if (Number(bodyCount) === 0) {
      await ds.query(
        `INSERT INTO body_composition
          (record_date, weight_kg, bmi, body_fat_pct, body_fat_mass_kg, muscle_mass_kg,
           skeletal_muscle_mass_kg, visceral_fat_level, subcutaneous_fat_pct, protein_pct, water_pct, notes)
         VALUES ('2026-07-15', 89.75, 28.30, 27.0, 24.2, 62.0, 34.2, 12, 19.3, 16.4, 51.9,
                 '基线测量（由 health 仓库 data/body-composition/2026-07-15.json 迁移）')`
      );
    }

    const [{ c: profileCount }] = await ds.query(
      'SELECT COUNT(*) AS c FROM health_profile'
    );
    if (Number(profileCount) === 0) {
      const goals = JSON.stringify([
        {
          horizon: '3个月',
          target: '体重 ≤ 85 kg',
          metric: 'weight_kg',
          value: 85,
        },
        {
          horizon: '6个月',
          target: '体重 ≤ 80 kg，内脏脂肪等级 ≤ 10',
          metric: 'weight_kg',
          value: 80,
        },
        {
          horizon: '12个月',
          target: '体重 74–78 kg，体脂率 18–20%',
          metric: 'weight_kg',
          value: 76,
        },
      ]);
      await ds.query(
        `INSERT INTO health_profile
          (id, height_cm, birth_year, sex, activity_factor, deficit_kcal, protein_per_kg, goal_weight_kg, goals_json)
         VALUES (1, 178.2, 1995, 'male', 1.25, 400, 1.80, 76.0, ?)`,
        [goals]
      );
    }
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `health 查询超时（${label} >${HealthDbService.QUERY_TIMEOUT_MS}ms）`
            )
          ),
        HealthDbService.QUERY_TIMEOUT_MS
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

  /** 丢弃当前连接池（下次 ensure 重建），半死连接自愈用。 */
  private async reset(): Promise<void> {
    const pending = this.dsPromise;
    this.dsPromise = null;
    if (pending) {
      try {
        const ds = await pending;
        await ds.destroy();
      } catch {
        /* 池子本就烂了 */
      }
    }
  }

  /** SELECT（幂等，失败重建连接池重试一次）。占位符用 ? */
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

  /** DML。写非幂等，只加超时、不自动重试（避免重复写）。 */
  async exec(sql: string, params: any[] = []): Promise<any> {
    const ds = await this.ensure();
    return await this.withTimeout(ds.query(sql, params), 'exec');
  }
}
