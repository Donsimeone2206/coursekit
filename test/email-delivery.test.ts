import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Migrator } from 'kysely/migration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/server/db/index.js';
import * as initial from '../src/server/db/migrations/001_initial.js';
import { createCoursekit, resolveConfig, type Coursekit } from '../src/server/index.js';
import { newId } from '../src/server/lib/util.js';
import { resolveEmailConfig } from '../src/server/services/email/config.js';
import { isPermanentError, pruneOutbox, retryDelayMs } from '../src/server/services/email/outbox.js';
import { EmailService, emailServiceFor, fromHeader } from '../src/server/services/email/service.js';
import { brandPalette, markdownToText } from '../src/server/services/email/templates.js';
import { MISSING_NODEMAILER, smtpOptionsFromUrl, smtpSender } from '../src/server/services/email/transport.js';
import { notify } from '../src/server/services/notify.js';
import { createEmailLms, freshDatabase, memoryTransport, outbox, type MemoryTransport } from './email-helpers.js';
import { setupSchool } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let lms: Coursekit | null = null;

afterEach(async () => {
  await lms?.close();
  lms = null;
  vi.restoreAllMocks();
});

async function withUser(transport: MemoryTransport, options: Parameters<typeof createEmailLms>[1] = {}) {
  lms = await createEmailLms(transport, options);
  const user = await lms.createUser({ name: 'Sam Student', email: 'sam@test.dev', password: 'test-password' });
  return { lms, userId: user.id };
}

const minutes = (n: number) => n * 60_000;

describe('retries and backoff', () => {
  it('retries a temporary failure with growing delays, then delivers', async () => {
    const transport = memoryTransport();
    transport.failWith = (call) => (call <= 2 ? Object.assign(new Error('421 Try again later'), { responseCode: 421 }) : null);
    const { lms, userId } = await withUser(transport);
    await notify(lms.db, [userId], { type: 'grade', title: 'New grade' });
    const t0 = new Date();

    expect(await lms.email.processOutbox({ now: t0 })).toEqual({ sent: 0, failed: 0, retrying: 1 });
    let [row] = await outbox(lms);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastError: '421 Try again later', lockId: null });
    const firstDelay = new Date(row!.nextAttemptAt).getTime() - t0.getTime();
    expect(firstDelay).toBeGreaterThanOrEqual(minutes(0.8));
    expect(firstDelay).toBeLessThanOrEqual(minutes(1.2));

    // Not due yet.
    expect(await lms.email.processOutbox({ now: new Date(t0.getTime() + 30_000) })).toEqual({ sent: 0, failed: 0, retrying: 0 });

    const t1 = new Date(t0.getTime() + minutes(2));
    expect(await lms.email.processOutbox({ now: t1 })).toMatchObject({ retrying: 1 });
    [row] = await outbox(lms);
    const secondDelay = new Date(row!.nextAttemptAt).getTime() - t1.getTime();
    expect(secondDelay).toBeGreaterThanOrEqual(minutes(4));
    expect(secondDelay).toBeLessThanOrEqual(minutes(6));

    expect(await lms.email.processOutbox({ now: new Date(t1.getTime() + minutes(7)) })).toEqual({ sent: 1, failed: 0, retrying: 0 });
    [row] = await outbox(lms);
    expect(row).toMatchObject({ status: 'sent', attempts: 3 });
    expect(transport.sent).toHaveLength(1);
  });

  it('gives up straight away on a permanent failure, and after the last attempt otherwise', async () => {
    const transport = memoryTransport();
    transport.failWith = (_call, message) =>
      message.to === 'sam@test.dev' ? Object.assign(new Error('550 No such user'), { responseCode: 550 }) : new Error('Connection reset');
    const { lms, userId } = await withUser(transport);
    const failed = vi.fn();
    lms.events.on('email.failed', failed);
    await notify(lms.db, [userId], { type: 'grade', title: 'New grade' });
    expect(await lms.email.processOutbox()).toEqual({ sent: 0, failed: 1, retrying: 0 });
    expect((await outbox(lms))[0]).toMatchObject({ status: 'failed', attempts: 1 });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({ willRetry: false, error: '550 No such user' })));

    const other = await lms.createUser({ name: 'Kim', email: 'kim@test.dev', password: 'test-password' });
    await notify(lms.db, [other.id], { type: 'grade', title: 'Another' });
    await lms.db.updateTable('emailOutbox').set({ maxAttempts: 2 }).where('toAddress', '=', 'kim@test.dev').execute();
    const t0 = Date.now();
    await lms.email.processOutbox({ now: new Date(t0) });
    await lms.email.processOutbox({ now: new Date(t0 + minutes(2)) });
    const kim = (await outbox(lms)).find((r) => r.toAddress === 'kim@test.dev')!;
    expect(kim).toMatchObject({ status: 'failed', attempts: 2, lastError: 'Connection reset' });
  });

  it('stops a run when the server seems down, without using up the other messages', async () => {
    const transport = memoryTransport();
    transport.failWith = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' });
    const { lms } = await withUser(transport);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await lms.createUser({ name: `P${i}`, email: `p${i}@test.dev`, password: 'test-password' })).id);
    await notify(lms.db, ids, { type: 'announcement', title: 'Hello' });
    expect(await lms.email.processOutbox()).toEqual({ sent: 0, failed: 0, retrying: 3 });
    const rows = await outbox(lms);
    expect(rows.filter((r) => r.attempts === 1)).toHaveLength(3);
    expect(rows.filter((r) => r.attempts === 0 && r.status === 'pending' && r.lockId === null)).toHaveLength(2);
  });

  it('picks up messages a crashed process had claimed once the claim expires', async () => {
    const transport = memoryTransport();
    const { lms, userId } = await withUser(transport);
    await notify(lms.db, [userId], { type: 'grade', title: 'New grade' });
    const now = new Date();
    await lms.db
      .updateTable('emailOutbox')
      .set({ status: 'sending', lockId: 'crashed', lockedUntil: new Date(now.getTime() + minutes(5)).toISOString(), attempts: 1 })
      .execute();
    expect(await lms.email.processOutbox({ now })).toMatchObject({ sent: 0 });
    expect(await lms.email.processOutbox({ now: new Date(now.getTime() + minutes(11)) })).toMatchObject({ sent: 1 });
    expect((await outbox(lms))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('spreads retries out and classifies errors', () => {
    expect(retryDelayMs(1, () => 0.5)).toBe(minutes(1));
    expect(retryDelayMs(2, () => 0)).toBe(minutes(4));
    expect(retryDelayMs(50, () => 1)).toBe(Math.round(6 * 3_600_000 * 1.2));
    expect(isPermanentError(Object.assign(new Error('x'), { responseCode: 550 }))).toBe(true);
    expect(isPermanentError(Object.assign(new Error('x'), { responseCode: 535, code: 'EAUTH' }))).toBe(false);
    expect(isPermanentError(Object.assign(new Error('x'), { responseCode: 451 }))).toBe(false);
    expect(isPermanentError(Object.assign(new Error('x'), { permanent: true }))).toBe(true);
    expect(isPermanentError(new Error('x'))).toBe(false);
  });
});

describe('outbox upkeep', () => {
  it('deletes old messages and gives up on mail queued too long', async () => {
    const { lms, userId } = await withUser(memoryTransport());
    await notify(lms.db, [userId], { type: 'grade', title: 'Delivered' });
    await lms.email.processOutbox();
    await notify(lms.db, [userId], { type: 'grade', title: 'Stuck' });
    const day = 86_400_000;
    expect(await pruneOutbox(lms.db, new Date(Date.now() + 8 * day))).toEqual({ deleted: 0, expired: 1 });
    expect((await outbox(lms)).map((r) => [r.subject, r.status, r.lastError])).toEqual([
      ['Delivered', 'sent', null],
      ['Stuck', 'failed', 'Not sent within 7 days'],
    ]);
    expect(await pruneOutbox(lms.db, new Date(Date.now() + 40 * day))).toEqual({ deleted: 2, expired: 0 });
    expect(await outbox(lms)).toEqual([]);
  });

  it('scans for due digests once per digest slot', async () => {
    lms = await createEmailLms(memoryTransport());
    const service = emailServiceFor(lms.db)!;
    const sendDigests = vi.spyOn(service, 'sendDigests');
    const t = new Date('2030-01-08T12:00:00Z');
    await service.runOnce(t);
    await service.runOnce(new Date(t.getTime() + 61_000)); // nobody was due: same slot, no new scan
    expect(sendDigests).toHaveBeenCalledTimes(1);
    await service.runOnce(new Date(t.getTime() + 86_400_000)); // the next day's slot
    expect(sendDigests).toHaveBeenCalledTimes(2);
  });
});

describe('background worker', () => {
  it('delivers right after something is queued, and stops on close', async () => {
    const transport = memoryTransport();
    const sent = vi.fn();
    lms = await createEmailLms(transport, { email: { worker: true } });
    lms.events.on('email.sent', sent);
    const user = await lms.createUser({ name: 'Sam', email: 'sam@test.dev', password: 'test-password' });
    await notify(lms.db, [user.id], { type: 'grade', title: 'Straight to the inbox' });
    await vi.waitFor(() => expect(transport.sent.map((m) => m.subject)).toEqual(['Straight to the inbox']), { timeout: 5000 });
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'notification', to: 'sam@test.dev' })));
    expect((await lms.db.selectFrom('emailOutbox').select('status').executeTakeFirstOrThrow()).status).toBe('sent');
  });
});

describe('log transport', () => {
  it('prints each email and saves it as .eml and .html in <dataDir>/emails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dataDir = mkdtempSync(join(tmpdir(), 'coursekit-log-'));
    lms = await createCoursekit({ databaseUrl: 'sqlite::memory:', dataDir, webDir: false, email: { transport: 'log', worker: false } });
    const user = await lms.createUser({ name: 'Zoë', email: 'zoe@test.dev', password: 'test-password' });
    await notify(lms.db, [user.id], { type: 'grade', title: 'Note pour l’essai', body: 'Très bien' });
    expect(await lms.email.processOutbox()).toMatchObject({ sent: 1 });

    const files = readdirSync(join(dataDir, 'emails')).sort();
    expect(files.map((f) => f.slice(f.lastIndexOf('.')))).toEqual(['.eml', '.html']);
    const eml = readFileSync(join(dataDir, 'emails', files[0]!), 'utf8');
    expect(eml).toContain('To: zoe@test.dev');
    expect(eml).toContain(`Subject: =?UTF-8?B?${Buffer.from('Note pour l’essai').toString('base64')}?=`);
    expect(eml).toContain('Content-Type: multipart/alternative');
    const parts = eml.split(/--ck-[0-9a-z]+/);
    const text = Buffer.from(parts[1]!.split('\r\n\r\n')[1]!.replace(/\s+/g, ''), 'base64').toString('utf8');
    expect(text).toContain('Très bien');
    expect(readFileSync(join(dataDir, 'emails', files[1]!), 'utf8')).toContain('<!DOCTYPE html>');
    expect(log.mock.calls.flat().join('\n')).toContain('Note pour l’essai');
  });
});

/** Just enough of an SMTP server to receive messages from nodemailer. */
function fakeSmtpServer(options: { reply?: (command: string, messageIndex: number) => string | null } = {}) {
  const messages: Array<{ envelope: string[]; data: string; auth: string | null }> = [];
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let auth: string | null = null;
    let envelope: string[] = [];
    const send = (line: string) => socket.write(`${line}\r\n`);
    send('220 fake.test ESMTP');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          const data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const custom = options.reply?.('DATA-END', messages.length);
          if (custom) send(custom);
          else {
            messages.push({ envelope, data, auth });
            send('250 2.0.0 Queued');
          }
          envelope = [];
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.split(' ')[0]!.toUpperCase();
        const custom = options.reply?.(line, messages.length);
        if (custom) {
          send(custom);
          continue;
        }
        if (verb === 'EHLO') ['250-fake.test', '250-AUTH PLAIN', '250 8BITMIME'].forEach(send);
        else if (verb === 'HELO') send('250 fake.test');
        else if (verb === 'AUTH') {
          auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          send('235 2.7.0 Authenticated');
        } else if (verb === 'MAIL' || verb === 'RCPT') {
          envelope.push(line);
          send('250 2.1.0 OK');
        } else if (verb === 'DATA') {
          inData = true;
          send('354 Go ahead');
        } else if (verb === 'RSET' || verb === 'NOOP') send('250 OK');
        else if (verb === 'QUIT') {
          send('221 Bye');
          socket.end();
        } else send('502 Not implemented');
      }
    });
  });
  return {
    messages,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('SMTP transport', () => {
  it('delivers through an SMTP server with the credentials and headers from the URL', async () => {
    const smtp = fakeSmtpServer();
    const port = await smtp.listen();
    try {
      lms = await createCoursekit({
        databaseUrl: 'sqlite::memory:',
        dataDir: mkdtempSync(join(tmpdir(), 'coursekit-smtp-')),
        webDir: false,
        publicUrl: 'https://learn.example.test',
        email: { smtpUrl: `smtp://mailer%40example.test:p%40ss%20word@127.0.0.1:${port}`, from: 'learn@example.test', worker: false },
      });
      expect(lms.config.email.transport).toBe('smtp');
      const user = await lms.createUser({ name: 'Sam', email: 'sam@test.dev', password: 'test-password' });
      await notify(lms.db, [user.id], {
        type: 'grade',
        title: 'New grade for Essay',
        body: 'You received 9 / 10.',
        link: '/courses/x/grades',
      });
      expect(await lms.email.processOutbox()).toEqual({ sent: 1, failed: 0, retrying: 0 });

      expect(smtp.messages).toHaveLength(1);
      const [message] = smtp.messages;
      expect(message!.auth).toBe('\u0000mailer@example.test\u0000p@ss word');
      expect(message!.envelope[0]).toMatch(/^MAIL FROM:<learn@example\.test>/);
      expect(message!.envelope[1]).toBe('RCPT TO:<sam@test.dev>');
      const id = (await outbox(lms))[0]!.id;
      const data = message!.data.replace(/\r\n[ \t]+/g, ' '); // unfold long header lines
      expect(data).toMatch(/^From: "?Coursekit"? <learn@example\.test>\r?$/m);
      expect(data).toContain('Subject: New grade for Essay');
      expect(data).toContain(`Message-ID: <${id}@example.test>`);
      expect(data).toMatch(/List-Unsubscribe: <https:\/\/learn\.example\.test\/unsubscribe\?token=[^>]+>/);
      expect(data).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
      expect(data).toContain('Content-Type: multipart/alternative');
      expect(data).toContain('Content-Type: text/html');
    } finally {
      await smtp.close();
    }
  });

  it('retries after a temporary SMTP error and gives up on a permanent one', async () => {
    let dataReplies = 0;
    const smtp = fakeSmtpServer({
      reply: (command) => {
        if (command.startsWith('RCPT TO:<gone@test.dev>')) return '550 5.1.1 No such user';
        if (command === 'DATA-END' && dataReplies++ === 0) return '451 4.3.0 Try again later';
        return null;
      },
    });
    const port = await smtp.listen();
    try {
      lms = await createEmailLms('none', { email: { smtpUrl: `smtp://127.0.0.1:${port}`, transport: 'smtp' } });
      const sam = await lms.createUser({ name: 'Sam', email: 'sam@test.dev', password: 'test-password' });
      const gone = await lms.createUser({ name: 'Gone', email: 'gone@test.dev', password: 'test-password' });
      await notify(lms.db, [sam.id], { type: 'grade', title: 'First' });
      const t0 = Date.now();
      expect(await lms.email.processOutbox({ now: new Date(t0) })).toMatchObject({ retrying: 1 });
      expect((await outbox(lms))[0]!.lastError).toContain('451');
      expect(await lms.email.processOutbox({ now: new Date(t0 + minutes(2)) })).toMatchObject({ sent: 1 });

      await notify(lms.db, [gone.id], { type: 'grade', title: 'Second' });
      expect(await lms.email.processOutbox({ now: new Date(t0 + minutes(3)) })).toMatchObject({ failed: 1 });
      expect((await outbox(lms)).find((r) => r.toAddress === 'gone@test.dev')).toMatchObject({ status: 'failed', attempts: 1 });
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it('explains how to install nodemailer when it is missing, and keeps the email queued', async () => {
    const missing = () => Promise.reject(Object.assign(new Error("Cannot find package 'nodemailer'"), { code: 'ERR_MODULE_NOT_FOUND' }));
    const sender = smtpSender('smtp://127.0.0.1:2525', missing);
    await expect(sender.ready()).rejects.toThrow(MISSING_NODEMAILER);

    lms = await createEmailLms(memoryTransport());
    const service = new EmailService({ db: lms.db, config: lms.config, events: lms.events }, sender);
    const user = await lms.createUser({ name: 'Sam', email: 'sam@test.dev', password: 'test-password' });
    await notify(lms.db, [user.id], { type: 'grade', title: 'Waiting' });
    expect(await service.processOutbox()).toEqual({ sent: 0, failed: 0, retrying: 0 });
    expect((await outbox(lms))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await service.status()).transportError).toBe(MISSING_NODEMAILER);
  });

  it('turns the URL into nodemailer options', () => {
    expect(
      smtpOptionsFromUrl('smtps://u%3Aser:p%23ss@mail.example.test/?pool=true&maxConnections=3&tls.rejectUnauthorized=false&__proto__=x'),
    ).toMatchObject({
      host: 'mail.example.test',
      port: 465,
      secure: true,
      auth: { user: 'u:ser', pass: 'p#ss' },
      pool: true,
      maxConnections: 3,
      tls: { rejectUnauthorized: false },
      socketTimeout: 60_000,
    });
    expect(Object.hasOwn(smtpOptionsFromUrl('smtp://h/?__proto__=x'), '__proto__')).toBe(false);
    expect(smtpOptionsFromUrl('smtp://h:2525?socketTimeout=5000')).toMatchObject({ port: 2525, secure: false, socketTimeout: 5000 });
  });
});

describe('configuration', () => {
  it('is off unless configured, and reads the environment', () => {
    expect(resolveEmailConfig({}, {})).toMatchObject({ transport: 'none', worker: true });
    expect(resolveEmailConfig({}, { COURSEKIT_SMTP_URL: 'smtp://h:25', COURSEKIT_MAIL_FROM: 'A <a@b.test>' })).toMatchObject({
      transport: 'smtp',
      smtpUrl: 'smtp://h:25',
      from: 'A <a@b.test>',
    });
    expect(resolveEmailConfig({}, { COURSEKIT_MAIL_TRANSPORT: 'LOG', COURSEKIT_MAIL_WORKER: 'false' })).toMatchObject({
      transport: 'log',
      worker: false,
    });
    expect(resolveEmailConfig({ transport: 'none' }, { COURSEKIT_SMTP_URL: 'smtp://h:25' }).transport).toBe('none');
    const custom = { send: async () => {} };
    expect(resolveEmailConfig({ transport: custom }, {})).toMatchObject({ transport: 'custom', custom });
    expect(resolveConfig({ webDir: false }, {}).email.transport).toBe('none');
  });

  it('rejects broken settings with a clear message', () => {
    expect(() => resolveEmailConfig({ transport: 'smtp' }, {})).toThrow(/COURSEKIT_SMTP_URL/);
    expect(() => resolveEmailConfig({ smtpUrl: 'http://mail.example.test' }, {})).toThrow(/smtp:\/\//);
    expect(() => resolveEmailConfig({}, { COURSEKIT_MAIL_TRANSPORT: 'carrier-pigeon' })).toThrow(/Unknown email transport/);
    expect(() => resolveEmailConfig({ from: 'not an address' }, {})).toThrow(/from address/);
    expect(() => resolveEmailConfig({ from: 'a@b.test\r\nBcc: x@y.test' }, {})).toThrow(/from address/);
    expect(() => resolveEmailConfig({ transport: {} as never }, {})).toThrow(/send\(message\)/);
  });

  it('names the sender after the site', () => {
    expect(fromHeader(null, 'Acme "Academy"', 'https://learn.acme.test')).toEqual({
      from: '"Acme \\"Academy\\"" <no-reply@learn.acme.test>',
      isDefault: true,
    });
    expect(fromHeader('learn@acme.test', 'Acme', null)).toEqual({ from: '"Acme" <learn@acme.test>', isDefault: false });
    expect(fromHeader('Acme Learning <learn@acme.test>', 'Acme', null)).toEqual({
      from: 'Acme Learning <learn@acme.test>',
      isDefault: false,
    });
  });

  it('keeps brand colours readable in emails', () => {
    const yellow = brandPalette('#facc15');
    expect(yellow.onBrand).toBe('#0b0d12');
    expect(yellow.link).not.toBe('#facc15');
    expect(brandPalette('javascript:alert(1)').brand).toBe('#4f46e5');
    expect(brandPalette('#4F46E5')).toMatchObject({ brand: '#4f46e5', onBrand: '#ffffff' });
  });

  it('shows Markdown notification bodies as plain text', () => {
    expect(markdownToText('We will review **three** projects, _live_.')).toBe('We will review three projects, live.');
    expect(markdownToText('## Week 2\n> Read [the docs](https://x.test) and `npm test`')).toBe('Week 2\nRead the docs and npm test');
    expect(markdownToText('![diagram](a.png) ~~old~~ new')).toBe('diagram old new');
    // Unpaired markers and words with underscores stay as they are.
    expect(markdownToText('snake_case_name and 5 * 3 * 2, a **half')).toBe('snake_case_name and 5 * 3 * 2, a **half');
  });
});

describe('upgrading from 0.1.x', () => {
  it('adds the email tables and keeps existing people and notifications', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coursekit-upgrade-'));
    const database = await freshDatabase({ sqliteFile: true });
    const url = database.url;
    const old = await createDatabase(url);
    await new Migrator({
      db: old.db.withoutPlugins(),
      provider: { getMigrations: async () => ({ '001_initial': initial }) },
    }).migrateToLatest();
    const ts = new Date().toISOString();
    await old.db
      .insertInto('users')
      .values({
        id: 'olduser',
        email: 'old@test.dev',
        name: 'Old Timer',
        passwordHash: null,
        role: 'student',
        avatarUrl: null,
        bio: null,
        status: 'active',
        lastLoginAt: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .execute();
    await old.db
      .insertInto('notifications')
      .values({ id: 'oldnote', userId: 'olduser', type: 'grade', title: 'Old', body: '', link: null, readAt: null, createdAt: ts })
      .execute();
    await old.db.destroy();

    const transport = memoryTransport();
    lms = await createCoursekit({ databaseUrl: url, dataDir: dir, webDir: false, email: { transport, worker: false } });
    expect(await lms.db.selectFrom('notifications').select('id').execute()).toEqual([{ id: 'oldnote' }]);
    expect(await lms.db.selectFrom('emailPreferences').selectAll().execute()).toEqual([]);
    await notify(lms.db, ['olduser'], { type: 'grade', title: 'After the upgrade' });
    expect((await outbox(lms)).map((r) => r.toAddress)).toEqual(['old@test.dev']);
    await lms.close();
    lms = null;
    await database.drop();
  });
});

function runProcess(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'test/fixtures/email-process.ts'), ...args], { cwd: root });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (err.trim()) console.info(err.trim());
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${err}`));
    });
  });
}

describe('several server processes', () => {
  let drop: () => Promise<void> = async () => {};
  afterEach(() => drop());

  /** A database file (or PostgreSQL database) that several processes open at once. */
  async function sharedDatabase() {
    const dir = mkdtempSync(join(tmpdir(), 'coursekit-shared-'));
    const database = await freshDatabase({ sqliteFile: true });
    drop = database.drop;
    const setup = await createCoursekit({ databaseUrl: database.url, dataDir: dir, webDir: false });
    return { dir, url: database.url, setup };
  }

  it('never send the same email twice', async () => {
    const { dir, url, setup } = await sharedDatabase();
    const ts = new Date(Date.now() - 1000).toISOString();
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: newId(),
      kind: 'test' as const,
      userId: null,
      notificationId: null,
      toAddress: `person${i}@test.dev`,
      subject: `Message ${i}`,
      html: '<p>Hi</p>',
      text: 'Hi',
      headers: '{}',
      status: 'pending' as const,
      attempts: 0,
      maxAttempts: 8,
      nextAttemptAt: ts,
      lockId: null,
      lockedUntil: null,
      lastError: null,
      lastErrorAt: null,
      sentAt: null,
      createdAt: ts,
      updatedAt: ts,
    }));
    await setup.db.insertInto('emailOutbox').values(rows).execute();
    await setup.close();

    const startAt = String(Date.now() + 2500);
    const outputs = await Promise.all([runProcess([url, dir, 'outbox', startAt]), runProcess([url, dir, 'outbox', startAt])]);
    const [a, b] = outputs.map((o) => JSON.parse(o.trim().split('\n').pop()!).sent as string[]);
    expect(a!.length + b!.length).toBe(60);
    expect(new Set([...a!, ...b!]).size).toBe(60);

    const check = await createCoursekit({ databaseUrl: url, dataDir: dir, webDir: false });
    const statuses = await check.db.selectFrom('emailOutbox').select('status').execute();
    expect(statuses.every((s) => s.status === 'sent')).toBe(true);
    await check.close();
  }, 60_000);

  it('never send the same digest twice', async () => {
    const { dir, url, setup } = await sharedDatabase();
    const people = Array.from({ length: 40 }, (_, i) => ({ id: newId(), email: `digest${i}@test.dev` }));
    const ts = '2030-01-01T00:00:00.000Z';
    await setup.db
      .insertInto('users')
      .values(
        people.map((p) => ({
          ...p,
          name: p.email,
          passwordHash: null,
          role: 'student' as const,
          avatarUrl: null,
          bio: null,
          status: 'active' as const,
          lastLoginAt: null,
          createdAt: ts,
          updatedAt: ts,
        })),
      )
      .execute();
    await setup.db
      .insertInto('emailPreferences')
      .values(
        people.map((p) => ({
          userId: p.id,
          frequency: 'daily' as const,
          disabledCategories: '[]',
          lastDigestAt: '2030-01-07T08:00:00.000Z',
          digestClaim: null,
          updatedAt: ts,
        })),
      )
      .execute();
    await setup.db
      .insertInto('notifications')
      .values(
        people.map((p) => ({
          id: newId(),
          userId: p.id,
          type: 'announcement',
          title: 'News',
          body: '',
          link: null,
          readAt: null,
          createdAt: '2030-01-07T12:00:00.000Z',
        })),
      )
      .execute();
    await setup.db.insertInto('settings').values({ key: 'email.timezone', value: '"UTC"' }).execute();
    await setup.close();

    const now = '2030-01-08T08:00:30.000Z';
    const startAt = String(Date.now() + 2500);
    const outputs = await Promise.all([runProcess([url, dir, 'digests', startAt, now]), runProcess([url, dir, 'digests', startAt, now])]);
    const results = outputs.map((o) => JSON.parse(o.trim().split('\n').pop()!).result as { daily: number });
    expect(results[0]!.daily + results[1]!.daily).toBe(40);

    const check = await createCoursekit({ databaseUrl: url, dataDir: dir, webDir: false });
    const digests = await check.db.selectFrom('emailOutbox').select('userId').where('kind', '=', 'digest').execute();
    expect(digests).toHaveLength(40);
    expect(new Set(digests.map((d) => d.userId)).size).toBe(40);
    await check.close();
  }, 60_000);
});
