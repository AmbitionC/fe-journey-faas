import * as assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as ts from 'typescript';
import { DataSource, Entity, Column } from 'typeorm';
import { BaseEntity } from '../src/entity/base';

@Entity({ name: 'order' })
class BeforePaymentVerificationOrderEntity extends BaseEntity {
  @Column() userId: string;
  @Column() orderNo: string;
  @Column() type: string;
  @Column() name: string;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) amount: number;
  @Column({ nullable: true }) payTime: Date;
  @Column({ default: 'pending' }) status: string;
  @Column({ length: 64, nullable: true }) channel: string;
}

// Parse only; do not execute configuration or read credentials.
function schemaPolicy(text: string) {
  const source = ts.createSourceFile('schema-policy.ts', text, ts.ScriptTarget.Latest, true);
  const policy: Record<string, boolean> = {};
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/['"]/g, '');
      if (['synchronize', 'dropSchema', 'migrationsRun'].includes(name)) {
        assert.strictEqual(node.initializer.kind, ts.SyntaxKind.FalseKeyword, name + ' must be literal false');
        policy[name] = false;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepStrictEqual(Object.keys(policy).sort(), ['dropSchema', 'migrationsRun', 'synchronize']);
  return policy;
}
const guardPatch = () => JSON.parse(readFileSync(resolve(__dirname, '../scripts/migrations/20261005-schema-sync-guard.json'), 'utf8')).patch as string;
const guardPolicy = () => schemaPolicy('export default {' + guardPatch().split('\n')
  .filter(line => /^\+\s+(synchronize|dropSchema|migrationsRun):/.test(line))
  .map(line => line.slice(1)).join('\n') + '};');

describe('Schema-safe bridge and rollback', () => {
  it('the final version disables schema synchronization, drops and automatic migrations', () => {
    schemaPolicy(readFileSync(resolve(__dirname, '../src/config/config.default.ts'), 'utf8'));
  });

  it('the bridge disables automatic DDL without introducing new entity columns', () => {
    guardPolicy();
    const files = [...guardPatch().matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(match => match[1]);
    assert.deepStrictEqual(files.sort(), ['src/config/config.default.ts', 'src/service/growth/index.ts', 'src/service/order/index.ts']);
    assert.ok(!files.includes('src/entity/order.ts'));
    assert.ok(guardPatch().includes("['self_reported', 'paid'].includes(existing.status)"));
  });

  it('real TypeORM cold-start and rollback never calls DDL with the old entity', async () => {
    const policy = guardPolicy();
    for (const mode of ['cold-start', 'rollback-cold-start']) {
      const source = new DataSource({ type: 'mysql', database: 'fixture_only', entities: [BeforePaymentVerificationOrderEntity], ...policy });
      let connects = 0;
      let ddl = 0;
      source.driver.connect = async () => { connects++; };
      source.driver.disconnect = async () => {};
      source.driver.afterConnect = async () => {};
      source.synchronize = async () => { ddl++; };
      source.dropDatabase = async () => { ddl++; };
      source.runMigrations = async () => { ddl++; return []; };
      await source.initialize();
      assert.strictEqual(connects, 1, mode);
      assert.strictEqual(ddl, 0, mode);
      const columns = source.getMetadata(BeforePaymentVerificationOrderEntity).columns.map(column => column.propertyName);
      for (const column of ['bankVerified', 'bankVerifiedAt', 'bankVerifiedBy']) assert.ok(!columns.includes(column));
      await source.destroy();
    }
  });
});
