/// <reference types="node" preserve="true" />
/**
 * Coursekit: an open-source learning management system for Node.js.
 *
 * ```ts
 * import { createCoursekit } from 'coursekit-lms';
 *
 * const lms = await createCoursekit({ databaseUrl: 'sqlite://./data/lms.db' });
 * lms.events.on('grade.updated', (e) => console.log('graded', e));
 * await lms.listen(3000);
 * ```
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getRequestListener, serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import { resolveConfig, type CoursekitOptions, type ResolvedConfig } from './config.js';
import type { AppEnv } from './context.js';
import { createDatabase, migrateToLatest } from './db/index.js';
import type { DB, DatabaseKind } from './db/types.js';
import type { User } from '../shared/types.js';
import { EventBus } from './lib/events.js';
import { createLocalStorage, type FileStorage } from './lib/storage.js';
import { packageVersion } from './paths.js';
import { seedDemo, type SeedDemoOptions, type SeedDemoResult } from './seed/demo.js';
import { createEmailService, type CoursekitEmail } from './services/email/service.js';
import { startCompletionEngine } from './services/completion.js';
import { toUser } from './services/serialize.js';
import { createUser, type CreateUserInput } from './services/users.js';

export interface CreateCoursekitOptions extends CoursekitOptions {
  /** Custom file storage (S3, R2, ...). Defaults to `<dataDir>/uploads` on disk. */
  storage?: FileStorage | undefined;
}

export interface Coursekit {
  /** The Hono app. Mount it in another Hono app with `app.route('/', lms.app)`. */
  app: Hono<AppEnv>;
  /** Web-standard fetch handler (Bun, Deno, Cloudflare-style runtimes, tests). */
  fetch: (request: Request) => Response | Promise<Response>;
  /** Node `(req, res)` handler for `http.createServer`, Express or Fastify (mount at the root path). */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  db: DB;
  dbKind: DatabaseKind;
  events: EventBus;
  storage: FileStorage;
  config: ResolvedConfig;
  version: string;
  /** Start an HTTP server. Resolves once it is listening. */
  listen(port?: number, host?: string): Promise<{ server: Server; port: number; url: string }>;
  migrate(): Promise<void>;
  /** Creates an account. Returns the public user (never the password hash). */
  createUser(input: CreateUserInput): Promise<User>;
  seedDemo(options?: SeedDemoOptions): Promise<SeedDemoResult>;
  /** Outgoing email: digests, delivery of the outbox and test messages (no-ops while email is off). */
  email: CoursekitEmail;
  close(): Promise<void>;
}

export async function createCoursekit(options: CreateCoursekitOptions = {}): Promise<Coursekit> {
  const config = resolveConfig(options);
  const { db, kind } = await createDatabase(config.databaseUrl);
  if (config.migrate) await migrateToLatest(db);

  const events = new EventBus();
  const storage = options.storage ?? createLocalStorage(join(config.dataDir, 'uploads'));
  const version = packageVersion();
  const deps = { db, dbKind: kind, config, events, storage, version };
  const email = createEmailService(deps);
  const app = createApp(deps);
  const completion = startCompletionEngine(deps);
  const servers: Server[] = [];

  return {
    app,
    fetch: app.fetch,
    handler: getRequestListener(app.fetch),
    db,
    dbKind: kind,
    events,
    storage,
    config,
    version,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
          const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
          resolve({ server: server as Server, port: info.port, url: `http://${shownHost}:${info.port}` });
        }) as Server;
        server.once('error', reject);
        servers.push(server);
      });
    },
    async migrate() {
      await migrateToLatest(db);
    },
    createUser: async (input) => toUser(await createUser(deps, input)),
    seedDemo: (opts) => seedDemo(deps, opts),
    email,
    async close() {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      await completion.stop(); // may still queue notification emails
      await email.close();
      await db.destroy();
    },
  };
}

export { resolveConfig, type CoursekitOptions, type ResolvedConfig } from './config.js';
export { createApp } from './app.js';
export { EventBus, type CoursekitEvents, type EventName } from './lib/events.js';
export { createLocalStorage, type FileStorage } from './lib/storage.js';
export { activityTypes, type ActivityTypeDefinition } from './services/activity-types.js';
export type { Database } from './db/schema.js';
export type { DB, DatabaseKind } from './db/types.js';
export type { AppDeps, AppEnv } from './context.js';
export type { CreateUserInput } from './services/users.js';
export type { SeedDemoOptions, SeedDemoResult } from './seed/demo.js';
export type { EmailMessage, EmailOptions, EmailTransport, ResolvedEmailConfig } from './services/email/config.js';
export type { CoursekitEmail, DigestRunResult, OutboxRunResult } from './services/email/service.js';
export type * from '../shared/email.js';
export type * from '../shared/types.js';
export type * from '../shared/completion.js';
export type * from '../shared/open-badges.js';
export type * from '../shared/lti.js';
export { COURSE_CAPABILITIES, ROLE_CAPABILITIES, getCourseCapabilities, type CourseCapability } from '../shared/permissions.js';
