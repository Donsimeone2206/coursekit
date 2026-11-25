// Database types kept apart from db/index.ts, which imports `kysely/migration`: the public type
// declarations only reach this file, so they also resolve under TypeScript's legacy "node10" mode.
import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;
export type DatabaseKind = 'sqlite' | 'postgres';
