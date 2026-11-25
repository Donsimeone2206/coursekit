import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addressOf, describeSmtpUrl, type EmailMessage, type EmailTransport, type ResolvedEmailConfig } from './config.js';

/** A configured way of delivering email. */
export interface Sender {
  readonly kind: 'smtp' | 'log' | 'custom';
  /** e.g. "SMTP", "Log" or a custom transport's name. */
  readonly name: string;
  /** e.g. "smtp.example.com:587" or the folder emails are saved to. */
  readonly detail: string | null;
  /** Resolves once the transport can send; rejects with a helpful message when it can't (e.g. nodemailer is missing). */
  ready(): Promise<void>;
  send(message: EmailMessage): Promise<void>;
  close(): Promise<void>;
}

export const MISSING_NODEMAILER = 'SMTP email needs the "nodemailer" package. Install it with: npm install nodemailer';

// Just the parts of nodemailer Coursekit uses, so its types never leak into ours.
interface NodemailerTransporter {
  sendMail(mail: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
type CreateTransport = (options: Record<string, unknown>) => NodemailerTransporter;

export type ModuleLoader = () => Promise<unknown>;

const loadNodemailerModule: ModuleLoader = () => import('nodemailer');

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /cannot find (module|package)/i.test(String(err));
}

async function loadCreateTransport(load: ModuleLoader): Promise<CreateTransport> {
  let mod: unknown;
  try {
    mod = await load();
  } catch (err) {
    if (isModuleNotFound(err)) throw new Error(MISSING_NODEMAILER);
    throw err;
  }
  const m = mod as { createTransport?: unknown; default?: { createTransport?: unknown } };
  const create = m.createTransport ?? m.default?.createTransport;
  if (typeof create !== 'function') throw new Error('The installed "nodemailer" package has no createTransport().');
  return create as CreateTransport;
}

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * nodemailer options from an smtp:// or smtps:// URL. Credentials are percent-decoded, query parameters
 * become options (numbers and booleans converted, `tls.*` nested) and timeouts default to values short enough
 * that a stuck server can't hold a message for long.
 */
export function smtpOptionsFromUrl(smtpUrl: string): Record<string, unknown> {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  const options: Record<string, unknown> = {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    // Messages never reference files or URLs; refuse them outright.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (url.username || url.password) {
    options.auth = { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
  }
  const tls: Record<string, unknown> = {};
  for (const [key, raw] of url.searchParams) {
    const value = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    if (key.startsWith('tls.')) {
      const name = key.slice(4);
      if (name && !PROTO_KEYS.has(name)) tls[name] = value;
    } else if (!key.includes('.') && !PROTO_KEYS.has(key)) {
      options[key] = value;
    }
  }
  if (Object.keys(tls).length) options.tls = tls;
  return options;
}

/** The domain of the from address, for Message-IDs. */
function messageIdDomain(from: string): string {
  const address = addressOf(from);
  const domain = address?.slice(address.lastIndexOf('@') + 1).replace(/[^a-z0-9.-]/gi, '');
  return domain || 'coursekit.invalid';
}

export function smtpSender(smtpUrl: string, load: ModuleLoader = loadNodemailerModule): Sender {
  let transporter: Promise<NodemailerTransporter> | null = null;
  const get = () => (transporter ??= loadCreateTransport(load).then((create) => create(smtpOptionsFromUrl(smtpUrl))));
  return {
    kind: 'smtp',
    name: 'SMTP',
    detail: describeSmtpUrl(smtpUrl),
    async ready() {
      await get();
    },
    async send(message) {
      const t = await get();
      await t.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
        messageId: `<${message.id}@${messageIdDomain(message.from)}>`,
      });
    },
    async close() {
      const t = await transporter?.catch(() => null);
      t?.close();
    },
  };
}

function encodeWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Encodes the display name of "Name" <address> when it isn't plain ASCII. */
function encodeAddress(value: string): string {
  const m = /^\s*"?(.*?)"?\s*<([^<>]+)>\s*$/.exec(value);
  if (!m || /^[\x20-\x7e]*$/.test(m[1]!)) return value;
  return `${encodeWord(m[1]!.replace(/\\(.)/g, '$1'))} <${m[2]}>`;
}

function base64Lines(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
}

/** A complete RFC 5322 message, so saved emails open in any mail app. */
export function toMime(message: EmailMessage, date = new Date()): string {
  const boundary = `ck-${message.id}`;
  const headers: Array<[string, string]> = [
    ['From', encodeAddress(message.from)],
    ['To', message.to],
    ['Subject', encodeWord(message.subject)],
    ['Date', date.toUTCString()],
    ['Message-ID', `<${message.id}@${messageIdDomain(message.from)}>`],
    ['MIME-Version', '1.0'],
    ...Object.entries(message.headers),
    ['Content-Type', `multipart/alternative; boundary="${boundary}"`],
  ];
  return [
    ...headers.map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, ' ')}`),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Prints each email and saves it as .eml (opens in any mail app) and .html (opens in a browser). */
export function logSender(dir: string): Sender {
  return {
    kind: 'log',
    name: 'Log',
    detail: dir,
    async ready() {
      await mkdir(dir, { recursive: true });
    },
    async send(message) {
      await mkdir(dir, { recursive: true });
      const base = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${message.id}`);
      await writeFile(`${base}.eml`, toMime(message));
      await writeFile(`${base}.html`, message.html);
      console.log(
        [
          '',
          `[coursekit] Email to ${message.to} (log transport, saved to ${base}.eml)`,
          `  From:    ${message.from}`,
          `  Subject: ${message.subject}`,
          '',
          ...message.text.split('\n').map((line) => `  ${line}`),
          '',
        ].join('\n'),
      );
    },
    async close() {},
  };
}

export function customSender(transport: EmailTransport): Sender {
  return {
    kind: 'custom',
    name: transport.name?.trim() || 'Custom',
    detail: null,
    async ready() {},
    async send(message) {
      await transport.send(message);
    },
    async close() {},
  };
}

/** The sender for the configured transport, or null when email is off. */
export function createSender(config: ResolvedEmailConfig, dataDir: string): Sender | null {
  if (config.transport === 'custom' && config.custom) return customSender(config.custom);
  if (config.transport === 'smtp' && config.smtpUrl) return smtpSender(config.smtpUrl);
  if (config.transport === 'log') return logSender(join(dataDir, 'emails'));
  return null;
}
