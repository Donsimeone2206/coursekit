import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqliteDatabase, SqliteStatement } from 'kysely';

type SqlValue = null | number | bigint | string | Uint8Array;

function normalize(params: ReadonlyArray<unknown>): SqlValue[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value as SqlValue;
  });
}

const READER_FALLBACK = /^\s*(select|with|pragma|values|explain)\b|\breturning\b/i;

/**
 * Adapts Node's built-in `node:sqlite` module to the interface Kysely's SqliteDialect expects,
 * so Coursekit runs on SQLite with no native dependencies.
 */
export function createNodeSqliteDatabase(filename: string): SqliteDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (filename !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }

  const cache = new Map<string, StatementSync>();

  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      let stmt = cache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        if (cache.size > 500) cache.clear();
        cache.set(sql, stmt);
      }
      const s = stmt;
      const reader = typeof s.columns === 'function' ? s.columns().length > 0 : READER_FALLBACK.test(sql);
      return {
        reader,
        all: (params) => s.all(...normalize(params)),
        run: (params) => {
          const result = s.run(...normalize(params));
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        iterate: (params) => s.iterate(...normalize(params)) as IterableIterator<unknown>,
      };
    },
  };
}
