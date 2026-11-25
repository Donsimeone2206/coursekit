/**
 * Email delivery options: `createCoursekit({ email })` and the COURSEKIT_* environment variables.
 * Nothing here refers to nodemailer, so the public type declarations work without it installed.
 */

export type EmailTransportName = 'smtp' | 'log' | 'none';

/** One email, as handed to a transport. */
export interface EmailMessage {
  /** Outbox id. It stays the same across retries, so it works as an idempotency key. */
  id: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers: Record<string, string>;
}

/**
 * Delivers email through any provider (Resend, Postmark, SES, ...). Throw to report a failure: the message
 * is retried with backoff, unless the error has `permanent: true` or an SMTP-style `responseCode` of 500-599.
 */
export interface EmailTransport {
  send(message: EmailMessage): unknown;
  /** Shown on the admin page, e.g. "Resend". */
  name?: string | undefined;
}

export interface EmailOptions {
  /**
   * 'smtp' (needs `smtpUrl`), 'log' (prints emails and saves them to `<dataDir>/emails`), 'none', or your own
   * `{ send(message) }` transport. Defaults to $COURSEKIT_MAIL_TRANSPORT, else 'smtp' when an SMTP URL is set,
   * else 'none' (email off).
   */
  transport?: EmailTransportName | EmailTransport | undefined;
  /** smtp://user:password@host:587 or smtps://user:password@host:465. Defaults to $COURSEKIT_SMTP_URL. */
  smtpUrl?: string | undefined;
  /** Sender, e.g. "Acme Academy <learn@acme.example>". Defaults to $COURSEKIT_MAIL_FROM. */
  from?: string | undefined;
  /**
   * Deliver queued email and send digests in the background of this process. Defaults to true
   * ($COURSEKIT_MAIL_WORKER=false turns it off, e.g. when `coursekit send-digests` runs from cron).
   */
  worker?: boolean | undefined;
}

export interface ResolvedEmailConfig {
  transport: EmailTransportName | 'custom';
  custom: EmailTransport | null;
  smtpUrl: string | null;
  from: string | null;
  worker: boolean;
}

const TRANSPORT_NAMES: readonly string[] = ['smtp', 'log', 'none'];

function clean(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The bare address of "Name <a@b>" or "a@b", or null when there is none. */
export function addressOf(value: string): string | null {
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  const address = angle ? angle[1]! : value.trim();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(address) ? address : null;
}

export function resolveEmailConfig(options: EmailOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedEmailConfig {
  const smtpUrl = clean(options.smtpUrl ?? env.COURSEKIT_SMTP_URL);
  const from = clean(options.from ?? env.COURSEKIT_MAIL_FROM);
  const workerEnv = env.COURSEKIT_MAIL_WORKER?.trim().toLowerCase();
  const worker = options.worker ?? !['0', 'false', 'no', 'off'].includes(workerEnv ?? '');

  if (from && (/[\r\n]/.test(from) || !addressOf(from))) {
    throw new Error('The email from address must be an address, optionally with a name, e.g. "Acme Academy <learn@acme.example>".');
  }

  const chosen = options.transport ?? clean(env.COURSEKIT_MAIL_TRANSPORT)?.toLowerCase();
  if (chosen && typeof chosen === 'object') {
    if (typeof chosen.send !== 'function') throw new Error('A custom email transport needs a send(message) method.');
    return { transport: 'custom', custom: chosen, smtpUrl, from, worker };
  }
  const name = chosen ?? (smtpUrl ? 'smtp' : 'none');
  if (!TRANSPORT_NAMES.includes(name)) throw new Error(`Unknown email transport "${name}". Use smtp, log or none.`);
  if (name === 'smtp') {
    if (!smtpUrl) throw new Error('The "smtp" email transport needs COURSEKIT_SMTP_URL, e.g. smtp://user:password@smtp.example.com:587');
    let url: URL | null = null;
    try {
      url = new URL(smtpUrl);
    } catch {
      // reported below
    }
    if (!url || !/^smtps?:$/.test(url.protocol) || !url.hostname) {
      throw new Error('COURSEKIT_SMTP_URL must look like smtp://user:password@host:587 or smtps://user:password@host:465');
    }
  }
  return { transport: name as EmailTransportName, custom: null, smtpUrl, from, worker };
}

/** "smtp.example.com:587" or "smtp.example.com:465 (TLS)", never the credentials. */
export function describeSmtpUrl(smtpUrl: string): string {
  try {
    const url = new URL(smtpUrl);
    const secure = url.protocol === 'smtps:';
    return `${url.hostname}:${url.port || (secure ? 465 : 587)}${secure ? ' (TLS)' : ''}`;
  } catch {
    return 'SMTP server';
  }
}
