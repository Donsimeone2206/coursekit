import { resolve } from 'node:path';
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect, type Dialect } from 'kysely';
import { Migrator, type Migration, type MigrationResult } from 'kysely/migration';
import * as initial from './migrations/001_initial.js';
import * as email from './migrations/002_email.js';
import * as groupsCohorts from './migrations/003_groups_cohorts.js';
import * as completionBadges from './migrations/004_completion_badges.js';
import * as questionBank from './migrations/005_question_bank.js';
import * as gradeCategories from './migrations/006_grade_categories.js';
import * as lti from './migrations/007_lti.js';
import * as packages from './migrations/008_packages.js';
import * as groupModes from './migrations/009_group_modes.js';
import * as questionSharing from './migrations/010_question_sharing.js';
import * as openBadges from './migrations/011_open_badges.js';
import { createNodeSqliteDatabase } from './node-sqlite.js';
import type { Database } from './schema.js';
import type { DB, DatabaseKind } from './types.js';

export type { DB, DatabaseKind } from './types.js';

/** Migrations are registered in code so they survive bundling. Append new ones; never edit old ones. */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_email': email,
  '003_groups_cohorts': groupsCohorts,
  '004_completion_badges': completionBadges,
  '005_question_bank': questionBank,
  '006_grade_categories': gradeCategories,
  '007_lti': lti,
  '008_packages': packages,
  '009_group_modes': groupModes,
  '010_question_sharing': questionSharing,
  '011_open_badges': openBadges,
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
