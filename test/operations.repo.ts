import { readFileSync, writeFileSync } from 'fs';

/** Durable file adapter for local tests only; production uses the TypeORM MySQL repository. */
export class FileOperationsRepository {
  constructor(private path: string) {}
  private read(): any[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  private write(rows: any[]) {
    writeFileSync(this.path, JSON.stringify(rows));
  }
  async insert(row: any) {
    const rows = this.read();
    if (rows.some(r => r.id === row.id)) throw new Error('duplicate');
    rows.push(row);
    this.write(rows);
  }
  async findOneBy(where: any) {
    return this.read().find(r => r.id === where.id) || null;
  }
  async update(where: any, row: any) {
    const rows = this.read();
    const index = rows.findIndex(
      r => r.id === where.id && r.revision === where.revision
    );
    if (index < 0) return { affected: 0 };
    rows[index] = row;
    this.write(rows);
    return { affected: 1 };
  }
  async findAndCount(options: any) {
    const items = this.read().filter(r =>
      Object.entries(options.where).every(([key, value]: any) =>
        key === 'title'
          ? r.title.includes(
              value._value.slice(1, -1).replace(/\\([\\%_])/g, '$1')
            )
          : r[key] === value
      )
    );
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [
      items.slice(options.skip, options.skip + options.take),
      items.length,
    ];
  }
}
