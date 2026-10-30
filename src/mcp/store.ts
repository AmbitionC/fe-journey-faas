import { createHash, randomBytes } from 'crypto';

/**
 * MCP 的 API Key 与调用日志（主库 fe-journey，两张表由本模块唯一拥有）。
 *
 * - Key 只存 sha256 哈希，明文只在签发那一刻返回一次。
 * - 管理员手发的 Key（user_id 为空）不扣点，只记日志 + 每日上限；用户自助开的 Key
 *   （带 user_id）按次扣「Journey 点」，扣点逻辑在 ./billing.ts。
 * - 建表幂等（CREATE TABLE IF NOT EXISTS）：主库 synchronize=false，新表不经实体同步。
 */

export type Product = 'agent' | 'invest';
export type KeyScope = Product | 'all';

export interface ApiKeyRow {
  id: number;
  key_prefix: string;
  scope: KeyScope;
  owner: string;
  note: string | null;
  status: 'active' | 'revoked';
  daily_limit: number;
  created_at: string;
  last_used_at: string | null;
  /** 自助开通的 Key 归属的平台用户；管理员手发的为 null（不扣点）。 */
  user_id?: string | null;
}

/** 执行 SQL 的最小接口（生产用 TypeORM DataSource.query，单测用假实现）。 */
export type QueryFn = (sql: string, params?: any[]) => Promise<any>;

/** Redis 的最小接口（INCR 计数用）。 */
export interface CounterLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<any>;
}

export const KEY_PREFIX = 'jk_';
export const DEFAULT_DAILY_LIMIT = 2000;

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(24).toString('base64url');
}

/** 从 Authorization: Bearer xxx 或 X-API-Key 头取 Key。 */
export function extractKey(headers: Record<string, any>): string | null {
  const auth = String(headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const raw = (m ? m[1] : String(headers['x-api-key'] || '')).trim();
  return raw.startsWith(KEY_PREFIX) ? raw : null;
}

export function scopeAllows(scope: KeyScope, product: Product): boolean {
  return scope === 'all' || scope === product;
}

/** 北京时间日期串 YYYYMMDD（每日额度按北京日切）。 */
export function beijingYmd(now = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export class McpStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private q: QueryFn, private counter?: CounterLike | null) {}

  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_api_key (
          id INT AUTO_INCREMENT PRIMARY KEY,
          key_hash CHAR(64) NOT NULL,
          key_prefix VARCHAR(16) NOT NULL,
          scope VARCHAR(16) NOT NULL DEFAULT 'all',
          owner VARCHAR(128) NOT NULL,
          note VARCHAR(255) NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'active',
          daily_limit INT NOT NULL DEFAULT ${DEFAULT_DAILY_LIMIT},
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME NULL,
          UNIQUE KEY uk_mcp_key_hash (key_hash)
        ) DEFAULT CHARSET=utf8mb4`);
        await this.q(`CREATE TABLE IF NOT EXISTS mcp_call_log (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          key_id INT NOT NULL,
          product VARCHAR(16) NOT NULL,
          tool VARCHAR(64) NOT NULL,
          ok TINYINT NOT NULL DEFAULT 1,
          latency_ms INT NOT NULL DEFAULT 0,
          error VARCHAR(300) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_mcp_log_key_time (key_id, created_at),
          KEY idx_mcp_log_time (created_at)
        ) DEFAULT CHARSET=utf8mb4`);
        // 第二版加的列：线上表第一版已建，CREATE IF NOT EXISTS 不会补列，
        // MySQL 8 也没有 ADD COLUMN IF NOT EXISTS，先查 information_schema 再补。
        const cols = await this.q(
          "SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mcp_api_key'"
        );
        const names = new Set(
          (cols || []).map((r: any) =>
            String(r.c ?? r.COLUMN_NAME).toLowerCase()
          )
        );
        if (!names.has('user_id')) {
          await this.q(
            'ALTER TABLE mcp_api_key ADD COLUMN user_id VARCHAR(64) NULL, ADD KEY idx_mcp_key_user (user_id)'
          );
        }
      })().catch(e => {
        this.schemaReady = null; // 允许下次重试
        throw e;
      });
    }
    return this.schemaReady;
  }

  /** 按明文 Key 查有效记录；不存在或已吊销返回 null。 */
  async findActive(key: string): Promise<ApiKeyRow | null> {
    await this.ensureSchema();
    const rows = await this.q(
      'SELECT id, key_prefix, scope, owner, note, status, daily_limit, created_at, last_used_at, user_id ' +
        "FROM mcp_api_key WHERE key_hash = ? AND status = 'active' LIMIT 1",
      [hashKey(key)]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async create(p: {
    scope: KeyScope;
    owner: string;
    note?: string;
    dailyLimit?: number;
    userId?: string;
  }) {
    await this.ensureSchema();
    const key = generateKey();
    const limit = Math.max(
      1,
      Math.min(100000, Number(p.dailyLimit) || DEFAULT_DAILY_LIMIT)
    );
    await this.q(
      'INSERT INTO mcp_api_key (key_hash, key_prefix, scope, owner, note, daily_limit, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        hashKey(key),
        key.slice(0, 10),
        p.scope,
        p.owner.slice(0, 128),
        (p.note || '').slice(0, 255) || null,
        limit,
        p.userId || null,
      ]
    );
    return {
      key,
      prefix: key.slice(0, 10),
      scope: p.scope,
      owner: p.owner,
      dailyLimit: limit,
    };
  }

  async list(): Promise<ApiKeyRow[]> {
    await this.ensureSchema();
    return this.q(
      'SELECT id, key_prefix, scope, owner, note, status, daily_limit, created_at, last_used_at, user_id ' +
        'FROM mcp_api_key ORDER BY id DESC LIMIT 500'
    );
  }

  /** 某用户自己的 Key（自助后台用）。 */
  async listByUser(userId: string): Promise<ApiKeyRow[]> {
    await this.ensureSchema();
    return this.q(
      'SELECT id, key_prefix, scope, owner, note, status, daily_limit, created_at, last_used_at, user_id ' +
        'FROM mcp_api_key WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      [userId]
    );
  }

  async countActiveByUser(userId: string): Promise<number> {
    await this.ensureSchema();
    const rows = await this.q(
      "SELECT COUNT(*) n FROM mcp_api_key WHERE user_id = ? AND status = 'active'",
      [userId]
    );
    return Number(rows?.[0]?.n ?? 0);
  }

  /** 用户只能吊销自己的 Key。 */
  async revokeOwn(id: number, userId: string): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.q(
      "UPDATE mcp_api_key SET status = 'revoked' WHERE id = ? AND user_id = ?",
      [id, userId]
    );
    return Number(r?.affectedRows ?? 0) > 0;
  }

  async revoke(id: number): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.q(
      "UPDATE mcp_api_key SET status = 'revoked' WHERE id = ?",
      [id]
    );
    return Number(r?.affectedRows ?? 0) > 0;
  }

  /**
   * 计一次调用并判断是否超出当日上限。返回 { used, limit, over }。
   * Redis 不可用时放行（宁可多给，不因计数故障拒掉付费用户）。
   */
  async countCall(row: ApiKeyRow, now = new Date(), limitOverride?: number) {
    const limit =
      limitOverride || Number(row.daily_limit) || DEFAULT_DAILY_LIMIT;
    if (!this.counter) return { used: 0, limit, over: false };
    try {
      const k = `mcp:q:${row.id}:${beijingYmd(now)}`;
      const used = await this.counter.incr(k);
      if (used === 1) await this.counter.expire(k, 2 * 24 * 3600);
      return { used, limit, over: used > limit };
    } catch {
      return { used: 0, limit, over: false };
    }
  }

  async usedToday(row: ApiKeyRow, now = new Date()): Promise<number | null> {
    if (!this.counter) return null;
    try {
      const anyCounter = this.counter as any;
      if (typeof anyCounter.get !== 'function') return null;
      return Number(
        (await anyCounter.get(`mcp:q:${row.id}:${beijingYmd(now)}`)) || 0
      );
    } catch {
      return null;
    }
  }

  async log(p: {
    keyId: number;
    product: Product;
    tool: string;
    ok: boolean;
    latencyMs: number;
    error?: string;
  }) {
    await this.ensureSchema();
    await this.q(
      'INSERT INTO mcp_call_log (key_id, product, tool, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)',
      [
        p.keyId,
        p.product,
        p.tool.slice(0, 64),
        p.ok ? 1 : 0,
        Math.round(p.latencyMs),
        p.error ? p.error.slice(0, 300) : null,
      ]
    );
    await this.q('UPDATE mcp_api_key SET last_used_at = NOW() WHERE id = ?', [
      p.keyId,
    ]);
  }

  /** 近 N 天按 Key × 工具聚合的调用量（管理端看用量）。 */
  async usage(days = 7) {
    await this.ensureSchema();
    const d = Math.max(1, Math.min(90, Math.floor(days)));
    return this.q(
      'SELECT l.key_id, k.key_prefix, k.owner, l.product, l.tool, COUNT(*) calls, ' +
        'SUM(l.ok = 0) errors, ROUND(AVG(l.latency_ms)) avg_ms ' +
        'FROM mcp_call_log l LEFT JOIN mcp_api_key k ON k.id = l.key_id ' +
        'WHERE l.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ' +
        'GROUP BY l.key_id, k.key_prefix, k.owner, l.product, l.tool ORDER BY calls DESC LIMIT 500',
      [d]
    );
  }
}
