import { IMidwayContainer } from '@midwayjs/core';
import { TypeORMDataSourceManager } from '@midwayjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * 主库补列（幂等，只加不改不删）。
 *
 * 主库 synchronize=false。TypeORM 查实体时会 SELECT 实体上的全部列，库里少一列整条
 * 查询就报 Unknown column，两站凡是读到这张表的接口一起挂。
 *
 * 2026-11-20 事故：北京时间 00:41:19，有一个仍开着 synchronize 的旧版后端连上主库，
 * 按它的旧实体把 user / order / algorithm_problem / book_order / user_article_action
 * 五张表「对齐」了一遍——旧实体里没有的列被直接删掉（user 少了 portfolioPublic /
 * portfolioHeadline），于是首页报 Unknown column 'user.portfolioPublic'。
 *
 * 冷启动时：
 * 1. 一条 information_schema 查询拿到库里现有的列，与实体元数据比对；
 * 2. 全齐（常态）就结束；
 * 3. 有缺列时，让 TypeORM 生成「同步需要的 SQL」但**不执行**，只挑出「给已存在的表加一个
 *    库里没有的列」的语句执行。删列、改列、建表、索引一律不碰，只记日志。
 * 任何异常只记日志，绝不阻断启动。
 */

type Query = (sql: string, params?: any[]) => Promise<any>;

export interface ColumnGap {
  table: string;
  column: string;
}

/** 实体声明了、库里（已存在的表）却没有的列。表整张不存在的另行返回，不在这里补。 */
export function findMissingColumns(
  entityCols: Record<string, string[]>,
  dbRows: Array<{ t?: string; c?: string; TABLE_NAME?: string; COLUMN_NAME?: string }>
): { missing: ColumnGap[]; missingTables: string[] } {
  const have = new Map<string, Set<string>>();
  for (const r of dbRows || []) {
    const t = String(r.t ?? r.TABLE_NAME).toLowerCase();
    const c = String(r.c ?? r.COLUMN_NAME).toLowerCase();
    if (!have.has(t)) have.set(t, new Set());
    have.get(t)!.add(c);
  }
  const missing: ColumnGap[] = [];
  const missingTables: string[] = [];
  for (const [table, cols] of Object.entries(entityCols)) {
    const set = have.get(table.toLowerCase());
    if (!set) {
      missingTables.push(table);
      continue;
    }
    for (const column of cols) if (!set.has(column.toLowerCase())) missing.push({ table, column });
  }
  return { missing, missingTables };
}

/** 从 TypeORM 同步 SQL 里只挑「给 gaps 里的列 ADD 列」的语句。 */
export function pickAddColumnSql(upQueries: string[], gaps: ColumnGap[]): string[] {
  const want = new Set(gaps.map(g => `${g.table}.${g.column}`.toLowerCase()));
  const out: string[] = [];
  for (const q of upQueries) {
    const m = /^ALTER TABLE `([^`]+)` ADD `([^`]+)` /.exec(q);
    if (!m) continue;
    const key = `${m[1]}.${m[2]}`.toLowerCase();
    if (want.has(key)) {
      out.push(q);
      want.delete(key);
    }
  }
  return out;
}

export async function addMissingEntityColumns(ds: DataSource, q: Query = (s, p) => ds.query(s, p)): Promise<string[]> {
  const entityCols: Record<string, string[]> = {};
  for (const m of ds.entityMetadatas) {
    if (m.tableType !== 'regular') continue;
    entityCols[m.tableName] = m.columns.map(c => c.databaseName);
  }
  const rows = await q(
    'SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  // 读不到列清单（权限问题等）时不动库
  if (!rows || !rows.length) return [];
  const { missing, missingTables } = findMissingColumns(entityCols, rows);
  if (missingTables.length) console.warn('[ensureEntityColumns] 库里没有这些表（不自动建）:', missingTables.join(', '));
  if (!missing.length) return [];

  const sql = await ds.driver.createSchemaBuilder().log();
  const adds = pickAddColumnSql(sql.upQueries.map(x => x.query), missing);
  const done: string[] = [];
  for (const s of adds) {
    await q(s);
    const m = /^ALTER TABLE `([^`]+)` ADD `([^`]+)`/.exec(s)!;
    done.push(`${m[1]}.${m[2]}`);
  }
  const left = missing.map(g => `${g.table}.${g.column}`).filter(k => !done.includes(k));
  if (left.length) console.warn('[ensureEntityColumns] 仍缺列（未生成可执行的加列语句）:', left.join(', '));
  return done;
}

export async function ensureEntityColumns(container: IMidwayContainer): Promise<void> {
  try {
    const mgr = await container.getAsync(TypeORMDataSourceManager);
    const ds = mgr.getDataSource('default');
    const added = await addMissingEntityColumns(ds);
    if (added.length) console.log('[ensureEntityColumns] 已补列:', added.join(', '));
  } catch (err) {
    console.error('[ensureEntityColumns] 失败(不影响启动):', err);
  }
}
