import { resolve } from 'node:path';
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect, type Dialect } from 'kysely';
import { Migrator, type Migration, type MigrationResult } from 'kysely/migration';
import * as initial from './migrations/001_initial.js';
import { createNodeSqliteDatabase } from './node-sqlite.js';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;
export type DatabaseKind = 'sqlite' | 'postgres';

/** Migrations are registered in code so they survive bundling. Append new ones; never edit old ones. */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
};

export async function createDatabase(url: string): Promise<{ db: DB; kind: DatabaseKind }> {
  let dialect: Dialect;
  let kind: DatabaseKind;

  if (/^postgres(ql)?:\/\//.test(url)) {
    kind = 'postgres';
    let pg: typeof import('pg');
    try {
      pg = await import('pg');
    } catch {
      throw new Error('PostgreSQL support needs the "pg" package. Install it with: npm install pg');
    }
    const Pool = pg.default?.Pool ?? pg.Pool;
    dialect = new PostgresDialect({ pool: new Pool({ connectionString: url, max: 10 }) });
  } else if (url.startsWith('sqlite:')) {
    kind = 'sqlite';
    const rest = url.slice('sqlite:'.length).replace(/^\/\//, '');
    const filename = rest === '' || rest === ':memory:' ? ':memory:' : resolve(rest);
    dialect = new SqliteDialect({ database: createNodeSqliteDatabase(filename) });
  } else {
    throw new Error(`Unsupported DATABASE_URL "${url}". Use sqlite://path/to/file.db or postgres://...`);
  }

  const db = new Kysely<Database>({ dialect, plugins: [new CamelCasePlugin()] });
  return { db, kind };
}

/** Runs all pending migrations. Migrations use explicit snake_case names, so plugins are disabled. */
export async function migrateToLatest(db: DB): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db: db.withoutPlugins(),
    provider: { getMigrations: async () => migrations },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return results ?? [];
}
