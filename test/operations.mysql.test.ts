import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { OperationsContentEntity } from '../src/entity/operationsContent';
import { OperationsService } from '../src/service/operations';

// Only the existing CI's disposable mysql:8 service. Never connect to a user database.
const disposableCI =
  process.env.CI === 'true' &&
  process.env.NODE_ENV === 'unittest' &&
  process.env.DB_HOST === '127.0.0.1' &&
  process.env.DB_USER === 'root' &&
  process.env.DB_PASS === 'testpass';
const suite = disposableCI ? describe : describe.skip;
suite('operations real MySQL storage in disposable CI', function () {
  this.timeout(15000);
  let db: DataSource;
  const ownedIds: string[] = [];
  const connect = () =>
    new DataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: 'fe-journey',
      entities: [OperationsContentEntity],
      synchronize: false,
      dropSchema: false,
      migrationsRun: false,
      logging: false,
    });
  const service = (connection: DataSource) => {
    const value = new OperationsService();
    value.model = connection.getRepository(OperationsContentEntity);
    value.ossService = { signedUrl: key => `synthetic:${key}` } as any;
    return value;
  };
  const input = {
    title: '[SYNTHETIC CI] operations',
    body: 'Not user material',
    platform: 'xiaohongshu',
    images: [
      {
        key: 'operations/images/synthetic-ci.png',
        name: '[SYNTHETIC CI] image',
      },
    ],
    note: 'Disposable test only',
  };
  before(async () => {
    db = await connect().initialize();
    // Apply the exact additive SQL, only inside CI's isolated container.
    await db.query(
      readFileSync(
        join(
          __dirname,
          '../scripts/migrations/20261010-operations-content.sql'
        ),
        'utf8'
      )
    );
  });
  after(async () => {
    if (db?.isInitialized) {
      for (const id of ownedIds)
        await db.getRepository(OperationsContentEntity).delete({ id });
      await db.destroy();
    }
  });
  it('creates the JSON table with the checked-in migration', async () => {
    const [column] = await db.query(
      "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='operations_content' AND COLUMN_NAME='document'"
    );
    assert.strictEqual(column.DATA_TYPE, 'json');
    const indexes = await db.query('SHOW INDEX FROM operations_content');
    assert.ok(
      indexes.some(index => index.Key_name === 'operations_status_updated')
    );
    assert.ok(
      indexes.some(index => index.Key_name === 'operations_platform_updated')
    );
  });
  it('roundtrips immutable publication and null/zero metrics over a new connection', async () => {
    const s = service(db);
    let row = await s.create(
      { ...input, title: input.title + randomUUID() },
      'synthetic-admin'
    );
    ownedIds.push(row.id);
    row = await s.command(
      {
        id: row.id,
        revision: row.revision,
        type: 'publish',
        publishedAt: '2026-10-09T00:00:00.000Z',
        url: 'https://example.com/synthetic',
      },
      'synthetic-admin'
    );
    const publishedVersion = row.document.versions[0];
    const publicationId = row.document.publications[0].id;
    row = await s.command(
      {
        id: row.id,
        revision: row.revision,
        type: 'save',
        ...input,
        title: '[SYNTHETIC CI] new draft',
        images: [],
      },
      'synthetic-admin'
    );
    row = await s.command(
      {
        id: row.id,
        revision: row.revision,
        type: 'review',
        publicationId,
        observedAt: '2026-10-09T01:00:00.000Z',
        likes: 0,
      },
      'synthetic-admin'
    );
    const fresh = await connect().initialize();
    try {
      const reloaded = await service(fresh).get(row.id);
      assert.strictEqual(reloaded.status, 'draft');
      assert.strictEqual(reloaded.document.versions.length, 2);
      assert.strictEqual(
        reloaded.document.publications[0].versionId,
        publishedVersion.id
      );
      assert.deepStrictEqual(reloaded.document.versions[0], publishedVersion);
      assert.deepStrictEqual(reloaded.document.reviews[0].metrics, {
        views: null,
        likes: 0,
        saves: null,
        comments: null,
      });
      assert.strictEqual(
        reloaded.document.events.at(-1).versionId,
        publishedVersion.id
      );
    } finally {
      await fresh.destroy();
    }
  });
  it('real conditional UPDATE accepts only one simultaneous save', async () => {
    const s = service(db);
    const row = await s.create(input, 'synthetic-admin');
    ownedIds.push(row.id);
    const commands = ['A', 'B'].map(title =>
      s.command(
        { id: row.id, revision: row.revision, type: 'save', ...input, title },
        'synthetic-admin'
      )
    );
    const results = await Promise.allSettled(commands);
    assert.strictEqual(
      results.filter(result => result.status === 'fulfilled').length,
      1
    );
    const rejected = results.find(
      result => result.status === 'rejected'
    ) as PromiseRejectedResult;
    assert.strictEqual(rejected.reason.status, 409);
    const stored = await s.get(row.id);
    assert.strictEqual(stored.revision, 2);
    assert.strictEqual(stored.document.versions.length, 2);
  });
});
