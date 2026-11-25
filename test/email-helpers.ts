import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCoursekit,
  type Coursekit,
  type CreateCoursekitOptions,
  type EmailMessage,
  type EmailTransport,
} from '../src/server/index.js';
import { newId } from '../src/server/lib/util.js';

export const PUBLIC_URL = 'https://learn.example.test';

export interface MemoryTransport extends EmailTransport {
  sent: EmailMessage[];
  calls: number;
  /** Throw this from the next sends (a function gets the 1-based call number). */
  failWith: ((call: number, message: EmailMessage) => unknown) | null;
}

/** A transport that keeps messages in memory and can be told to fail. */
export function memoryTransport(): MemoryTransport {
  const transport: MemoryTransport = {
    name: 'Memory',
    sent: [],
    calls: 0,
    failWith: null,
    async send(message: EmailMessage) {
      transport.calls++;
      const error = transport.failWith?.(transport.calls, message);
      if (error) throw error;
      transport.sent.push(message);
    },
  };
  return transport;
}

/**
 * Set COURSEKIT_TEST_POSTGRES_URL (e.g. postgres://user@127.0.0.1:5432/postgres) to run the email tests
 * on PostgreSQL: each Coursekit then gets a new database, dropped again on close.
 */
const POSTGRES_URL = process.env.COURSEKIT_TEST_POSTGRES_URL;

/** A new, empty database: in memory (or a file, to share it between processes), or on PostgreSQL. */
export async function freshDatabase(options: { sqliteFile?: boolean } = {}): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!POSTGRES_URL) {
    const url = options.sqliteFile ? `sqlite://${join(mkdtempSync(join(tmpdir(), 'coursekit-db-')), 'test.db')}` : 'sqlite::memory:';
    return { url, drop: async () => {} };
  }
  const { default: pg } = await import('pg');
  const name = `ck_email_${newId(12)}`;
  const admin = async (sql: string) => {
    const c = new pg.Client({ connectionString: POSTGRES_URL });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  await admin(`create database ${name}`);
  const url = new URL(POSTGRES_URL);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => admin(`drop database if exists ${name}`) };
}

/** A Coursekit with email delivered to `transport`. The background worker is off: tests drive it. */
export async function createEmailLms(
  transport: EmailTransport | 'log' | 'none' = memoryTransport(),
  options: Partial<CreateCoursekitOptions> = {},
): Promise<Coursekit> {
  const database = await freshDatabase();
  const lms = await createCoursekit({
    databaseUrl: database.url,
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-email-')),
    webDir: false,
    publicUrl: PUBLIC_URL,
    ...options,
    email: { transport, worker: false, ...options.email },
  });
  const close = lms.close;
  lms.close = async () => {
    await close();
    await database.drop();
  };
  return lms;
}

export function outbox(lms: Coursekit) {
  return lms.db.selectFrom('emailOutbox').selectAll().orderBy('createdAt').execute();
}

/** The unsubscribe token from an email's List-Unsubscribe header. */
export function tokenFrom(message: EmailMessage): string {
  const header = message.headers['List-Unsubscribe'] ?? '';
  const match = /token=([^>&]+)/.exec(header);
  if (!match) throw new Error(`No unsubscribe token in ${JSON.stringify(message.headers)}`);
  return decodeURIComponent(match[1]!);
}
