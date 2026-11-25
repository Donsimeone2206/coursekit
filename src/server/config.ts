import { resolve } from 'node:path';
import { defaultWebDir } from './paths.js';

export interface CoursekitOptions {
  /** `sqlite://./data/coursekit.db` (default), `sqlite::memory:` or a `postgres://` URL. */
  databaseUrl?: string | undefined;
  /** Folder for uploaded files and the default SQLite database. Defaults to `./data`. */
  dataDir?: string | undefined;
  port?: number | undefined;
  host?: string | undefined;
  /** Public URL of the site. An https URL turns on secure cookies. */
  publicUrl?: string | undefined;
  /** Maximum upload size in megabytes. Defaults to 50. */
  maxUploadMb?: number | undefined;
  /** Folder with the built web UI. `false` serves the API only. */
  webDir?: string | false | undefined;
  /** Run pending database migrations on startup. Defaults to true. */
  migrate?: boolean | undefined;
  /** Log each request to the console. */
  logRequests?: boolean | undefined;
}

export interface ResolvedConfig {
  databaseUrl: string;
  dataDir: string;
  port: number;
  host: string;
  publicUrl: string | null;
  maxUploadBytes: number;
  webDir: string | null;
  migrate: boolean;
  logRequests: boolean;
  secureCookies: boolean;
}

export function resolveConfig(options: CoursekitOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const dataDir = resolve(options.dataDir ?? env.COURSEKIT_DATA_DIR ?? './data');
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL ?? `sqlite://${resolve(dataDir, 'coursekit.db')}`;
  const publicUrl = options.publicUrl ?? env.COURSEKIT_PUBLIC_URL ?? null;
  const maxUploadMb = options.maxUploadMb ?? Number(env.COURSEKIT_MAX_UPLOAD_MB ?? 50);
  const webDir = options.webDir === false ? null : (options.webDir ?? defaultWebDir());

  return {
    databaseUrl,
    dataDir,
    port: options.port ?? Number(env.PORT ?? 3000),
    host: options.host ?? env.HOST ?? '0.0.0.0',
    publicUrl,
    maxUploadBytes: Math.max(1, maxUploadMb) * 1024 * 1024,
    webDir,
    migrate: options.migrate ?? true,
    logRequests: options.logRequests ?? false,
    secureCookies: publicUrl?.startsWith('https://') ?? false,
  };
}
