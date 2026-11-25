import type { Context } from 'hono';
import type { ResolvedConfig } from './config.js';
import type { DB, DatabaseKind } from './db/types.js';
import type { SessionRow, UserRow } from './db/schema.js';
import type { EventBus } from './lib/events.js';
import { forbidden, unauthorized } from './lib/http.js';
import type { FileStorage } from './lib/storage.js';

/** Everything a route needs. Created once per Coursekit instance. */
export interface AppDeps {
  db: DB;
  dbKind: DatabaseKind;
  config: ResolvedConfig;
  events: EventBus;
  storage: FileStorage;
  version: string;
}

export type AppEnv = {
  Variables: {
    user: UserRow | null;
    session: SessionRow | null;
  };
};

export type AppContext = Context<AppEnv>;

export function requireUser(c: AppContext): UserRow {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function requireAdmin(c: AppContext): UserRow {
  const user = requireUser(c);
  if (user.role !== 'admin') throw forbidden('Only administrators can do that.');
  return user;
}
