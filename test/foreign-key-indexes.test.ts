import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';

/** table.column of each foreign key that cascades on delete with no index that starts with its column (SQLite). */
async function unindexedCascades(db: Kysely<any>): Promise<string[]> {
  const tables = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'kysely_%'`.execute(db);
  const out: string[] = [];
  for (const { name } of tables.rows) {
    const leading = new Set<string>();
    for (const index of (await sql<{ name: string }>`select name from pragma_index_list(${name})`.execute(db)).rows) {
      const first = await sql<{ name: string }>`select name from pragma_index_info(${index.name}) where seqno = 0`.execute(db);
      if (first.rows[0]) leading.add(first.rows[0].name);
    }
    const keys = await sql<{ from: string; seq: number; on_delete: string }>`select * from pragma_foreign_key_list(${name})`.execute(db);
    for (const fk of keys.rows) if (fk.seq === 0 && fk.on_delete === 'CASCADE' && !leading.has(fk.from)) out.push(`${name}.${fk.from}`);
  }
  return out.sort();
}

it('indexes every foreign key that cascades, apart from the ones 0.3.0 left without an index', async () => {
  const { db } = await createDatabase('sqlite::memory:');
  try {
    const raw = db.withoutPlugins();
    // A site created by 0.3.0: the migrations up to and including 011_open_badges have run.
    const names = Object.keys(migrations).filter((name) => name <= '011_open_badges');
    const v030 = new Migrator({
      db: raw,
      provider: { getMigrations: async () => Object.fromEntries(names.map((n) => [n, migrations[n]!])) },
    });
    expect((await v030.migrateToLatest()).error).toBeUndefined();
    const before = await unindexedCascades(raw);
    // Deleting a user or a course scans these tables; deleting a package version scans none.
    expect(before).toContain('submissions.user_id');
    expect(before.filter((c) => c.endsWith('.version_id'))).toEqual([]);

    const results = await migrateToLatest(db);
    expect(results.every((r) => r.status === 'Success')).toBe(true);
    expect((await unindexedCascades(raw)).filter((c) => !before.includes(c))).toEqual([]);
  } finally {
    await db.destroy();
  }
});
