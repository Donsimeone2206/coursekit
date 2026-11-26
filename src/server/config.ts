import { resolve } from 'node:path';
import { resolveTrustProxy, type TrustProxyOption, type TrustProxySetting } from './lib/client-address.js';
import { defaultWebDir } from './paths.js';
import { resolveEmailConfig, type EmailOptions, type ResolvedEmailConfig } from './services/email/config.js';

export interface CoursekitOptions {
  /** `sqlite://./data/coursekit.db` (default), `sqlite::memory:` or a `postgres://` URL. */
  databaseUrl?: string | undefined;
  /** Folder for uploaded files and the default SQLite database. Defaults to `./data`. */
  dataDir?: string | undefined;
  port?: number | undefined;
  host?: string | undefined;
  /**
   * Public URL of the site. An https URL turns on secure cookies (so a proxy's X-Forwarded-Proto isn't
   * needed or read).
   */
  publicUrl?: string | undefined;
  /** Maximum upload size in megabytes. Defaults to 50. */
  maxUploadMb?: number | undefined;
  /** Maximum uncompressed size of a SCORM or xAPI package in megabytes. Defaults to 500. */
  maxPackageMb?: number | undefined;
  /** Folder with the built web UI. `false` serves the API only. */
  webDir?: string | false | undefined;
  /** Run pending database migrations on startup. Defaults to true. */
  migrate?: boolean | undefined;
  /** Log each request to the console. */
  logRequests?: boolean | undefined;
  /** Outgoing email (notifications and digests). Off unless a transport or COURSEKIT_SMTP_URL is set. */
  email?: EmailOptions | undefined;
  /**
   * Reverse proxies whose X-Forwarded-For Coursekit believes when it needs the client's address (rate
   * limits). Off by default: the connection's address, and requests that came through a proxy (or from
   * this machine) only get the sign-in and sign-up limits per email. A list (or comma-separated string) of
   * addresses and CIDR ranges, with the shortcuts `loopback`, `linklocal` and `uniquelocal`; a number of
   * proxies in front of Coursekit; or `true` for every proxy, only when Coursekit can't be reached except
   * through a proxy that replaces X-Forwarded-For. Env: COURSEKIT_TRUST_PROXY.
   */
  trustProxy?: TrustProxyOption | undefined;
}

export interface ResolvedConfig {
  databaseUrl: string;
  dataDir: string;
  port: number;
  host: string;
  publicUrl: string | null;
  maxUploadBytes: number;
  maxPackageBytes: number;
  webDir: string | null;
  migrate: boolean;
  logRequests: boolean;
  secureCookies: boolean;
  email: ResolvedEmailConfig;
  /** false (off), true, a number of proxies, or a list of addresses, CIDR ranges and shortcuts. */
  trustProxy: TrustProxySetting;
}

export function resolveConfig(options: CoursekitOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const dataDir = resolve(options.dataDir ?? env.COURSEKIT_DATA_DIR ?? './data');
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL ?? `sqlite://${resolve(dataDir, 'coursekit.db')}`;
  const publicUrl = options.publicUrl ?? env.COURSEKIT_PUBLIC_URL ?? null;
  const maxUploadMb = options.maxUploadMb ?? Number(env.COURSEKIT_MAX_UPLOAD_MB ?? 50);
  const maxPackageMb = options.maxPackageMb ?? Number(env.COURSEKIT_MAX_PACKAGE_MB ?? 500);
  const webDir = options.webDir === false ? null : (options.webDir ?? defaultWebDir());

  return {
    databaseUrl,
    dataDir,
    port: options.port ?? Number(env.PORT ?? 3000),
    host: options.host ?? env.HOST ?? '0.0.0.0',
    publicUrl,
    maxUploadBytes: Math.max(1, maxUploadMb) * 1024 * 1024,
    maxPackageBytes: Math.max(1, Number.isFinite(maxPackageMb) ? maxPackageMb : 500) * 1024 * 1024,
    webDir,
    migrate: options.migrate ?? true,
    logRequests: options.logRequests ?? false,
    secureCookies: publicUrl?.startsWith('https://') ?? false,
    email: resolveEmailConfig(options.email, env),
    trustProxy:
      options.trustProxy !== undefined
        ? resolveTrustProxy(options.trustProxy, 'trustProxy')
        : resolveTrustProxy(env.COURSEKIT_TRUST_PROXY, 'COURSEKIT_TRUST_PROXY'),
  };
}
