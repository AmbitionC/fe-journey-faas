import * as assert from 'assert';
import { DataSource } from 'typeorm';
import { UserEntity } from '../src/entity/user';
import { OrderEntity } from '../src/entity/order';
import { addMissingEntityColumns, findMissingColumns, pickAddColumnSql } from '../src/bootstrap/ensureEntityColumns';

// 2026-11-20 00:41 被旧版后端改过之后，线上 user / order 两张表的真实列
const LIVE_USER = ['id', 'nickName', 'password', 'createTime', 'updateTime', 'phoneNumber', 'avatar', 'memberDate', 'isMember', 'inviteCode', 'role'];
const LIVE_ORDER = ['id', 'createTime', 'updateTime', 'userId', 'orderNo', 'type', 'name', 'amount', 'payTime', 'status'];

async function offlineDataSource(upQueries: string[]) {
  const ds = new DataSource({ type: 'mysql', database: 'fixture_only', entities: [UserEntity, OrderEntity], synchronize: false });
  (ds.driver as any).connect = async () => {};
  (ds.driver as any).disconnect = async () => {};
  (ds.driver as any).afterConnect = async () => {};
  await ds.initialize();
  (ds.driver as any).createSchemaBuilder = () => ({
    log: async () => ({ upQueries: upQueries.map(query => ({ query })), downQueries: [] }),
  });
  return ds;
}

const liveRows = () => [
  ...LIVE_USER.map(c => ({ t: 'user', c })),
  ...LIVE_ORDER.map(c => ({ t: 'order', c })),
];

describe('主库补列（只加不删）', () => {
  it('线上 11-20 的列清单：找出 user / order 被删掉的列', () => {
    const { missing } = findMissingColumns(
      { user: [...LIVE_USER, 'portfolioPublic', 'portfolioHeadline'], order: LIVE_ORDER },
      liveRows()
    );
    assert.deepStrictEqual(missing, [
      { table: 'user', column: 'portfolioPublic' },
      { table: 'user', column: 'portfolioHeadline' },
    ]);
  });

  it('表整张不存在时只报告、不当缺列补', () => {
    const r = findMissingColumns({ user: LIVE_USER, ghost: ['id'] }, liveRows());
    assert.deepStrictEqual(r.missing, []);
    assert.deepStrictEqual(r.missingTables, ['ghost']);
  });

  it('同步 SQL 里只挑加缺列的语句，删列/改列/索引/已存在列一律不执行', () => {
    const picked = pickAddColumnSql(
      [
        'ALTER TABLE `user` DROP COLUMN `legacy`',
        'ALTER TABLE `user` ADD `portfolioPublic` tinyint NOT NULL COMMENT \'x\' DEFAULT 0',
        'ALTER TABLE `user` ADD `role` varchar(255) NOT NULL DEFAULT \'user\'',
        'ALTER TABLE `order` ADD UNIQUE INDEX `IDX_x` (`orderNo`)',
        'CREATE TABLE `ghost` (`id` int NOT NULL)',
      ],
      [{ table: 'user', column: 'portfolioPublic' }]
    );
    assert.deepStrictEqual(picked, ['ALTER TABLE `user` ADD `portfolioPublic` tinyint NOT NULL COMMENT \'x\' DEFAULT 0']);
  });

  it('端到端：用真实实体元数据补回 user / order 缺的列，且只发 ADD', async () => {
    // 用 TypeORM 对真实实体生成的 SQL 形状
    const up = [
      'ALTER TABLE `order` ADD `bankVerified` tinyint NOT NULL DEFAULT 0',
      'ALTER TABLE `order` ADD `bankVerifiedAt` datetime NULL',
      'ALTER TABLE `order` ADD `bankVerifiedBy` varchar(128) NULL',
      'ALTER TABLE `order` ADD `channel` varchar(64) NULL',
      'ALTER TABLE `user` ADD `portfolioPublic` tinyint NOT NULL DEFAULT 0',
      'ALTER TABLE `user` ADD `portfolioHeadline` varchar(255) NULL',
      'ALTER TABLE `order` CHANGE `status` `status` varchar(255) NOT NULL',
    ];
    const ds = await offlineDataSource(up);
    const sent: string[] = [];
    const added = await addMissingEntityColumns(ds, async sql => {
      sent.push(sql);
      return sql.startsWith('SELECT') ? liveRows() : [];
    });
    await ds.destroy();
    assert.deepStrictEqual(added.sort(), [
      'order.bankVerified', 'order.bankVerifiedAt', 'order.bankVerifiedBy', 'order.channel',
      'user.portfolioHeadline', 'user.portfolioPublic',
    ]);
    assert.ok(sent.slice(1).every(s => /^ALTER TABLE `[^`]+` ADD `/.test(s)));
  });

  it('列已齐时只查一次 information_schema、不生成也不执行 DDL', async () => {
    const ds = await offlineDataSource(['ALTER TABLE `user` ADD `x` int']);
    const meta = (t: string) => ds.entityMetadatas.find(m => m.tableName === t)!.columns.map(c => c.databaseName);
    const rows = [...meta('user').map(c => ({ t: 'user', c })), ...meta('order').map(c => ({ t: 'order', c }))];
    const sent: string[] = [];
    const added = await addMissingEntityColumns(ds, async sql => { sent.push(sql); return rows; });
    await ds.destroy();
    assert.deepStrictEqual(added, []);
    assert.strictEqual(sent.length, 1);
  });

  it('读不到列清单时不动库', async () => {
    const ds = await offlineDataSource(['ALTER TABLE `user` ADD `portfolioPublic` tinyint']);
    const sent: string[] = [];
    assert.deepStrictEqual(await addMissingEntityColumns(ds, async sql => { sent.push(sql); return []; }), []);
    await ds.destroy();
    assert.strictEqual(sent.length, 1);
  });
});
