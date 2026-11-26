import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SignJWT, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoursekit, resolveConfig, type Coursekit, type CoursekitOptions } from '../src/server/index.js';
import { clientAddress, limitAddress, normalizeAddress, rateLimitKey, resolveTrustProxy } from '../src/server/lib/client-address.js';
import { createFailureLimiter } from '../src/server/lib/rate-limit.js';
import { PASSWORD, setupSchool } from './helpers.js';
import { AGS, ISS, MockTool } from './lti-helpers.js';

// Hundreds of sign-ins: skip scrypt in this file (the limits are what's tested).
vi.mock('../src/server/lib/password.js', () => ({
  hashPassword: async (password: string) => `test$${password}`,
  verifyPassword: async (password: string, stored: string | null | undefined) => !!stored && stored === `test$${password}`,
}));

const PROXY = '127.0.0.1';

/** The env the Node server passes: a request that came in on a socket from `address`. */
const fromSocket = (address: string | undefined) =>
  address === undefined ? undefined : { incoming: { socket: { remoteAddress: address } } };

async function addressOf(trustProxy: unknown, socket: string | undefined, forwardedFor?: string): Promise<string> {
  const setting = resolveTrustProxy(trustProxy);
  const app = new Hono();
  app.get('/', (c) => c.text(clientAddress(c, { trustProxy: setting }) ?? 'unknown'));
  const res = await app.request(
    '/',
    { headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor } },
    fromSocket(socket),
  );
  return res.text();
}

const lmses: Coursekit[] = [];
async function newLms(options: CoursekitOptions = {}) {
  const lms = await createCoursekit({
    databaseUrl: 'sqlite::memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-proxy-')),
    webDir: false,
    publicUrl: ISS,
    ...options,
  });
  lmses.push(lms);
  return lms;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(lmses.splice(0).map((l) => l.close()));
});

describe('the client address', () => {
  it('is the socket address by default, whatever X-Forwarded-For says', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await addressOf(undefined, '203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
    expect(await addressOf(false, '::ffff:203.0.113.9', '198.51.100.1, 10.0.0.1')).toBe('203.0.113.9');
    expect(await addressOf(undefined, '2001:DB8::0:1')).toBe('2001:db8::1');
    expect(await addressOf(undefined, undefined, '198.51.100.1')).toBe('unknown');
    // One hint for the operator, not one per request.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('COURSEKIT_TRUST_PROXY');
  });

  it('walks X-Forwarded-For from the right past the listed proxies', async () => {
    const proxies = '10.0.0.1, 10.0.0.2';
    expect(await addressOf(proxies, '10.0.0.1', '198.51.100.7, 10.0.0.2')).toBe('198.51.100.7');
    // Entries the client made up sit left of the real one and are never reached.
    expect(await addressOf(proxies, '10.0.0.1', '6.6.6.6, 198.51.100.7, 10.0.0.2')).toBe('198.51.100.7');
    // A client that connects directly can't pretend to be someone else.
    expect(await addressOf(proxies, '198.51.100.8', '6.6.6.6, 10.0.0.2')).toBe('198.51.100.8');
    // All trusted: the furthest address.
    expect(await addressOf(proxies, '10.0.0.1', '10.0.0.2')).toBe('10.0.0.2');
    expect(await addressOf(proxies, '10.0.0.1')).toBe('10.0.0.1');
    expect(await addressOf(['10.0.0.1'], '10.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    // Without the socket address nothing in a list can be trusted.
    expect(await addressOf(proxies, undefined, '198.51.100.7')).toBe('unknown');
  });

  it('matches CIDR ranges, netmasks and the shortcuts', async () => {
    expect(await addressOf('10.0.0.0/8', '10.1.2.3', '198.51.100.7, 10.200.0.1')).toBe('198.51.100.7');
    expect(await addressOf('192.168.0.0/255.255.0.0', '192.168.4.4', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('192.168.0.0/255.255.0.0', '192.169.0.1', '198.51.100.7')).toBe('192.169.0.1');
    expect(await addressOf('172.16.0.0/12', '172.31.255.255', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('172.16.0.0/12', '172.32.0.0', '198.51.100.7')).toBe('172.32.0.0');
    expect(await addressOf('10.0.0.1/32', '10.0.0.2', '198.51.100.7')).toBe('10.0.0.2');
    expect(await addressOf('0.0.0.0/0', '203.0.113.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('loopback', '127.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('loopback', '127.8.8.8', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('loopback', '::1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('loopback', '10.0.0.1', '198.51.100.7')).toBe('10.0.0.1');
    expect(await addressOf('uniquelocal', '172.20.0.3', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('uniquelocal', 'fd12:3456::1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('linklocal', 'fe80::1%eth0', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('linklocal', '169.254.10.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('loopback, uniquelocal', '127.0.0.1', '198.51.100.7, 10.0.0.5')).toBe('198.51.100.7');
  });

  it('handles IPv6, IPv4-mapped addresses and ports', async () => {
    expect(await addressOf('2001:db8::/32', '2001:db8:1::1', '2001:DB8:0:0:0:0:0:5')).toBe('2001:db8::5');
    expect(await addressOf('2001:db8::/32', '2001:db9::1', '198.51.100.7')).toBe('2001:db9::1');
    expect(await addressOf('loopback', '::1', '[2001:db8::7]:4711')).toBe('2001:db8::7');
    expect(await addressOf('loopback', '::ffff:127.0.0.1', '::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('loopback', PROXY, '198.51.100.7:51000')).toBe('198.51.100.7');
    // A proxy listed as an IPv4-mapped address matches the IPv4 socket address, and the other way round.
    expect(await addressOf('::ffff:10.0.0.1', '10.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('10.0.0.1', '::ffff:10.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf('::ffff:10.0.0.0/104', '10.9.9.9', '198.51.100.7')).toBe('198.51.100.7');
    // An IPv6 range doesn't take in unrelated IPv4 addresses.
    expect(await addressOf('fc00::/7', '10.0.0.1', '198.51.100.7')).toBe('10.0.0.1');
  });

  it('counts hops, or trusts every proxy with true', async () => {
    const chain = '198.51.100.1, 198.51.100.2, 198.51.100.3';
    expect(await addressOf(1, '203.0.113.5', chain)).toBe('198.51.100.3');
    expect(await addressOf('2', '203.0.113.5', chain)).toBe('198.51.100.2');
    expect(await addressOf(3, '203.0.113.5', chain)).toBe('198.51.100.1');
    expect(await addressOf(10, '203.0.113.5', chain)).toBe('198.51.100.1');
    expect(await addressOf(1, '203.0.113.5')).toBe('203.0.113.5');
    // Hops don't need the socket address (the fetch handler on other runtimes).
    expect(await addressOf(1, undefined, chain)).toBe('198.51.100.3');
    expect(await addressOf(true, '203.0.113.5', chain)).toBe('198.51.100.1');
    expect(await addressOf('true', undefined, chain)).toBe('198.51.100.1');
  });

  it('stops at the last address it could trust when an entry is malformed', async () => {
    expect(await addressOf('loopback', PROXY, '198.51.100.7, not-an-address')).toBe(PROXY);
    expect(await addressOf('loopback', PROXY, '198.51.100.7, ')).toBe(PROXY);
    expect(await addressOf('loopback', PROXY, '198.51.100.7,,')).toBe(PROXY);
    expect(await addressOf(true, PROXY, 'made-up, 198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf(true, PROXY, '1.2.3.4, 999.1.1.1, 198.51.100.7')).toBe('198.51.100.7');
    expect(await addressOf(2, PROXY, '198.51.100.1, unknown')).toBe(PROXY);
    expect(await addressOf('loopback', 'not-a-socket', '198.51.100.7')).toBe('unknown');
    expect(await addressOf(true, PROXY, `${'1'.repeat(5000)}, 198.51.100.7`)).toBe('198.51.100.7');
    for (const bad of [
      '999.1.1.1',
      '01.2.3.4',
      '1.2.3',
      '1.2.3.4.5',
      '1:2:3',
      '1::2::3',
      '12345::1',
      'fe80::1%',
      '::ffff:1.2.3',
      '[1.2.3.4]x',
      '',
    ]) {
      expect(normalizeAddress(bad), bad).toBeNull();
    }
    expect(normalizeAddress('::FFFF:7f00:1')).toBe('127.0.0.1');
    expect(normalizeAddress('2001:0db8:0000:0000:0001:0000:0000:0001')).toBe('2001:db8::1:0:0:1');
    expect(normalizeAddress('1:0:0:1:0:0:0:1')).toBe('1:0:0:1::1');
    expect(normalizeAddress('::')).toBe('::');
    expect(normalizeAddress('1::')).toBe('1::');
    expect(normalizeAddress(' 198.51.100.7 ')).toBe('198.51.100.7');
    expect(normalizeAddress(42)).toBeNull();
  });
});

describe('limit keys', () => {
  it('group IPv6 addresses by /64 network and keep IPv4 addresses as they are', () => {
    expect(rateLimitKey('203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8:1:2::1')).toBe(rateLimitKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(rateLimitKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(rateLimitKey('fe80::1')).toBe('fe80::/64');
    expect(rateLimitKey('unknown')).toBe('unknown');
  });

  /** limitAddress for a request with these headers on a socket from `socket`. */
  async function limitKeyOf(trustProxy: unknown, socket: string | undefined, headers: Record<string, string> = {}) {
    const setting = resolveTrustProxy(trustProxy);
    const app = new Hono();
    app.get('/', (c) => c.text(limitAddress(c, { trustProxy: setting }) ?? 'none'));
    return (await app.request('/', { headers }, fromSocket(socket))).text();
  }

  it('leave out clients that a proxy forwarded while trustProxy is off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await limitKeyOf(undefined, '203.0.113.9')).toBe('203.0.113.9');
    expect(await limitKeyOf(undefined, '2001:db8:1:2::5')).toBe('2001:db8:1:2::/64');
    const forwarded: Array<Record<string, string>> = [
      { 'x-forwarded-for': '198.51.100.1' },
      { forwarded: 'for=198.51.100.1' },
      { 'x-real-ip': '198.51.100.1' },
    ];
    for (const headers of forwarded) {
      expect(await limitKeyOf(undefined, '203.0.113.9', headers), JSON.stringify(headers)).toBe('none');
    }
    // A proxy on this machine that sends none of those headers.
    expect(await limitKeyOf(undefined, '127.0.0.1')).toBe('none');
    expect(await limitKeyOf(undefined, '::1')).toBe('none');
    expect(await limitKeyOf(undefined, undefined)).toBe('none');
    // With trustProxy set, the client found in X-Forwarded-For counts, and a direct client can't opt out.
    expect(await limitKeyOf('loopback', '127.0.0.1', { 'x-forwarded-for': '198.51.100.1' })).toBe('198.51.100.1');
    expect(await limitKeyOf('loopback', '203.0.113.9', { 'x-forwarded-for': '198.51.100.1' })).toBe('203.0.113.9');
    expect(await limitKeyOf('loopback', '203.0.113.9', { 'x-real-ip': '198.51.100.1' })).toBe('203.0.113.9');
    expect(await limitKeyOf(1, '127.0.0.1', { 'x-forwarded-for': '2001:db8:7:7::1' })).toBe('2001:db8:7:7::/64');
  });
});

describe('the failure limiter', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('never lets more attempts than the limit fail, however many are checked at once', async () => {
    const limiter = createFailureLimiter(3, 60_000);
    const ends = await Promise.all([limiter.begin('a'), limiter.begin('a'), limiter.begin('a')]);
    expect(ends.every((end) => typeof end === 'function')).toBe(true);
    // The places left are all being checked: the next attempt waits instead of being refused.
    let fourth: ((failed: boolean) => void) | null | undefined;
    void limiter.begin('a').then((end) => (fourth = end));
    await tick();
    expect(fourth).toBeUndefined();
    // A correct one gives its place back.
    ends[0]!(false);
    await tick();
    expect(typeof fourth).toBe('function');
    // Failures keep theirs; once they reach the limit, waiting attempts are refused.
    let fifth: ((failed: boolean) => void) | null | undefined;
    void limiter.begin('a').then((end) => (fifth = end));
    await tick();
    expect(fifth).toBeUndefined();
    ends[1]!(true);
    ends[2]!(true);
    fourth!(true);
    fourth!(true); // ending twice counts once
    await tick();
    expect(fifth).toBeNull();
    expect(await limiter.begin('a')).toBeNull();
    // Other keys are separate.
    expect(typeof (await limiter.begin('b'))).toBe('function');
  });

  it('starts again in the next window, and gives up waiting after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const limiter = createFailureLimiter(1, 60_000, { maxWaitMs: 50 });
      (await limiter.begin('a'))!(true);
      expect(await limiter.begin('a')).toBeNull();
      vi.setSystemTime(Date.now() + 61_000);
      const end = await limiter.begin('a');
      expect(typeof end).toBe('function');
      // Still being checked: the next attempt waits, then gives up.
      vi.useRealTimers();
      expect(await limiter.begin('a')).toBeNull();
      end!(false);
      expect(typeof (await limiter.begin('a'))).toBe('function');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the trustProxy setting', () => {
  it('reads the option and COURSEKIT_TRUST_PROXY', () => {
    expect(resolveConfig({}, {}).trustProxy).toBe(false);
    expect(resolveConfig({}, { COURSEKIT_TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(resolveConfig({}, { COURSEKIT_TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(resolveConfig({}, { COURSEKIT_TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(resolveConfig({}, { COURSEKIT_TRUST_PROXY: 'TRUE' }).trustProxy).toBe(true);
    expect(resolveConfig({}, { COURSEKIT_TRUST_PROXY: ' 2 ' }).trustProxy).toBe(2);
    expect(resolveConfig({}, { COURSEKIT_TRUST_PROXY: 'Loopback, 10.0.0.0/8,,2001:DB8::/32' }).trustProxy).toEqual([
      'loopback',
      '10.0.0.0/8',
      '2001:db8::/32',
    ]);
    expect(resolveConfig({ trustProxy: ['uniquelocal'] }, { COURSEKIT_TRUST_PROXY: 'loopback' }).trustProxy).toEqual(['uniquelocal']);
    expect(resolveConfig({ trustProxy: false }, { COURSEKIT_TRUST_PROXY: 'true' }).trustProxy).toBe(false);
    expect(resolveConfig({ trustProxy: 1 }).trustProxy).toBe(1);
  });

  it('refuses values it cannot read, so a typo never trusts the wrong proxies', async () => {
    for (const value of [
      '10.0.0.0/33',
      '::/129',
      'nonsense',
      '1.2.3.4/255.0.255.0',
      '1.2.3.4/abc',
      'fe80::1%eth0',
      'loopbak',
      '10.0.0.0/-1',
      // Names every object has must not pass for shortcuts.
      'constructor',
      'tostring',
      '__proto__',
    ]) {
      expect(() => resolveConfig({}, { COURSEKIT_TRUST_PROXY: value }), value).toThrow(/COURSEKIT_TRUST_PROXY/);
    }
    for (const value of [-1, 1.5, 101, {}, [1], ['ok', 'loopback']]) {
      expect(() => resolveConfig({ trustProxy: value as never }), JSON.stringify(value)).toThrow(/trustProxy/);
    }
    await expect(createCoursekit({ databaseUrl: 'sqlite::memory:', webDir: false, trustProxy: 'nonsense' })).rejects.toThrow(/trustProxy/);
  });
});

/** A junk token request: signed with some other key but naming the tool's (public) client ID. */
async function junkTokenRequest(lms: Coursekit, clientId: string, forwardedFor: string | null, env: unknown = fromSocket(PROXY)) {
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(clientId)
    .sign((await generateKeyPair('RS256')).privateKey);
  const res = await lms.app.request(
    '/lti/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        scope: `${AGS}score`,
      }).toString(),
    },
    env,
  );
  return res.status;
}

describe('rate limits behind a proxy', () => {
  it('count failed token requests per client', async () => {
    const lms = await newLms({ trustProxy: 'loopback' });
    const school = await setupSchool(lms);
    const tool = await MockTool.create(lms);
    await tool.register(school.admin);
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push(await junkTokenRequest(lms, tool.clientId, '203.0.113.1'));
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(401));
    expect(statuses[60]).toBe(429);
    // Someone else behind the same proxy isn't affected, and neither is the tool.
    expect(await junkTokenRequest(lms, tool.clientId, '203.0.113.2')).toBe(401);
    expect((await tool.requestToken([`${AGS}score`])).status).toBe(200);
  });

  it('share one limit for everyone behind the proxy while trustProxy is off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lms = await newLms();
    const school = await setupSchool(lms);
    const tool = await MockTool.create(lms);
    await tool.register(school.admin);
    for (let i = 0; i < 60; i++) await junkTokenRequest(lms, tool.clientId, '203.0.113.1');
    expect(await junkTokenRequest(lms, tool.clientId, '203.0.113.2')).toBe(429);
  });

  /** `socket: null` is a request without a socket address (the fetch handler outside Node). */
  async function signInWith(lms: Coursekit, email: string, password: string, headers: Record<string, string>, socket: string | null) {
    const res = await lms.app.request(
      '/api/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, password }) },
      fromSocket(socket ?? undefined),
    );
    return res.status;
  }
  const signIn = (lms: Coursekit, email: string, password: string, forwardedFor: string | null, socket: string | null = PROXY) =>
    signInWith(lms, email, password, forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}, socket);

  async function signUp(lms: Coursekit, email: string, headers: Record<string, string>, socket: string | null = PROXY) {
    const res = await lms.app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'Learner', email, password: PASSWORD }),
      },
      fromSocket(socket ?? undefined),
    );
    return res.status;
  }
  const count = (statuses: number[]) => statuses.reduce<Record<number, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});

  it('count failed sign-ins per client, on top of the limit per email', async () => {
    const lms = await newLms({ trustProxy: 'loopback' });
    await setupSchool(lms);
    for (let i = 0; i < 100; i++) expect(await signIn(lms, `nobody${i}@a.test`, 'wrong-password', '203.0.113.1')).toBe(401);
    // That client is blocked, even with the right password; others behind the proxy are not.
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, '203.0.113.1')).toBe(429);
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, '203.0.113.2')).toBe(200);
    // Successful sign-ins never count.
    for (let i = 0; i < 120; i++) expect(await signIn(lms, 'kim@test.dev', PASSWORD, '203.0.113.3')).toBe(200);
    // The limit per email still applies across addresses. (It is kept for the whole process, so use an account of its own.)
    await lms.createUser({ name: 'Pat', email: 'pat@test.dev', password: PASSWORD });
    for (let i = 0; i < 10; i++) expect(await signIn(lms, 'pat@test.dev', 'wrong-password', `198.51.100.${i}`)).toBe(401);
    expect(await signIn(lms, 'pat@test.dev', PASSWORD, '198.51.100.200')).toBe(429);
  });

  it('never lock everyone behind an unconfigured proxy out: with trustProxy off, forwarded requests only get the limits per email', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lms = await newLms();
    await setupSchool(lms);
    // One client behind the proxy fails over and over: the others (and that client, with the right password) still get in.
    for (let i = 0; i < 150; i++) expect(await signIn(lms, `nobody${i}@b.test`, 'wrong-password', '203.0.113.1')).toBe(401);
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, '203.0.113.2')).toBe(200);
    expect(await signIn(lms, 'admin@test.dev', PASSWORD, '203.0.113.1')).toBe(200);
    // The same for proxies that send Forwarded or X-Real-IP, on any address, and for a proxy on this machine
    // that sends none of these headers.
    const proxies: Array<[Record<string, string>, string]> = [
      [{ forwarded: 'for=203.0.113.1' }, PROXY],
      [{ 'x-real-ip': '203.0.113.1' }, '10.0.0.7'],
      [{ 'x-forwarded-for': '203.0.113.1' }, '198.51.100.20'],
      [{}, '::1'],
      [{}, '::ffff:127.0.0.1'],
    ];
    for (const [n, [headers, socket]] of proxies.entries()) {
      const label = JSON.stringify([headers, socket]);
      for (let i = 0; i < 101; i++)
        expect(await signInWith(lms, `nobody${i}@p${n}.test`, 'wrong-password', headers, socket), label).toBe(401);
      expect(await signInWith(lms, 'kim@test.dev', PASSWORD, headers, socket), label).toBe(200);
    }
    // Sign-ups through the proxy aren't limited per address either.
    const signUps = [];
    for (let i = 0; i < 55; i++) signUps.push(await signUp(lms, `learner${i}@f.test`, { 'x-forwarded-for': `203.0.113.${i}` }));
    expect(count(signUps)).toEqual({ 201: 55 });
    // The limit per email still applies (it is kept for the whole process, so use an account of its own).
    await lms.createUser({ name: 'Lee', email: 'lee@test.dev', password: PASSWORD });
    for (let i = 0; i < 10; i++) expect(await signIn(lms, 'lee@test.dev', 'wrong-password', `198.51.100.${i}`)).toBe(401);
    expect(await signIn(lms, 'lee@test.dev', PASSWORD, '198.51.100.200')).toBe(429);

    // Without a socket address, only the limits per email apply too.
    const bare = await newLms();
    await setupSchool(bare);
    for (let i = 0; i < 101; i++) expect(await signIn(bare, `nobody${i}@c.test`, 'wrong-password', null, null)).toBe(401);
    expect(await signIn(bare, 'sam@test.dev', PASSWORD, null, null)).toBe(200);
  });

  it('still count clients that connect directly while trustProxy is off', async () => {
    const lms = await newLms();
    await setupSchool(lms);
    const direct = '203.0.113.77';
    for (let i = 0; i < 100; i++) expect(await signIn(lms, `nobody${i}@g.test`, 'wrong-password', null, direct)).toBe(401);
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, null, direct)).toBe(429);
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, null, '203.0.113.78')).toBe(200);
    for (let i = 0; i < 50; i++) expect(await signUp(lms, `direct${i}@g.test`, {}, '203.0.113.79')).toBe(201);
    expect(await signUp(lms, 'direct50@g.test', {}, '203.0.113.79')).toBe(429);
  });

  it('count failed sign-ins sent at the same time before checking their passwords', async () => {
    const lms = await newLms({ trustProxy: 'loopback' });
    await setupSchool(lms);
    const burst = await Promise.all(
      Array.from({ length: 250 }, (_, i) => signIn(lms, `burst${i}@h.test`, 'wrong-password', '203.0.113.50')),
    );
    // Only as many as the limit reach the password check.
    expect(count(burst)).toEqual({ 401: 100, 429: 150 });
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, '203.0.113.50')).toBe(429);

    // A school behind one address with 5 places left: 30 correct sign-ins at once wait for a place instead of
    // being refused, and give it back.
    for (let i = 0; i < 95; i++) expect(await signIn(lms, `typo${i}@h.test`, 'wrong-password', '203.0.113.51')).toBe(401);
    const learners = Array.from({ length: 30 }, (_, i) => `learner${i}@h.test`);
    for (const email of learners) await lms.createUser({ name: 'Learner', email, password: PASSWORD });
    const good = await Promise.all(learners.map((email) => signIn(lms, email, PASSWORD, '203.0.113.51')));
    expect(count(good)).toEqual({ 200: 30 });
    for (let i = 95; i < 100; i++) expect(await signIn(lms, `typo${i}@h.test`, 'wrong-password', '203.0.113.51')).toBe(401);
    expect(await signIn(lms, 'typo100@h.test', 'wrong-password', '203.0.113.51')).toBe(429);
  });

  it('count an IPv6 client by its /64 network', async () => {
    const lms = await newLms();
    await setupSchool(lms);
    // A host with a /64 can't get a fresh limit by picking another address in it.
    for (let i = 1; i <= 100; i++) {
      expect(await signIn(lms, `nobody${i}@i.test`, 'wrong-password', null, `2001:db8:1:2::${i.toString(16)}`)).toBe(401);
    }
    expect(await signIn(lms, 'nobody101@i.test', 'wrong-password', null, '2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(429);
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, null, '2001:db8:1:2::ffff')).toBe(429);
    expect(await signIn(lms, 'sam@test.dev', PASSWORD, null, '2001:db8:1:3::1')).toBe(200);
    // IPv4 addresses, IPv4-mapped ones included, count one by one.
    expect(await signIn(lms, 'kim@test.dev', PASSWORD, null, '::ffff:203.0.113.90')).toBe(200);
  });

  it('count failed token and registration requests from an IPv6 client by its /64 network', async () => {
    const lms = await newLms({ trustProxy: 'loopback' });
    const school = await setupSchool(lms);
    const tool = await MockTool.create(lms);
    await tool.register(school.admin);
    const statuses: number[] = [];
    for (let i = 1; i <= 61; i++) statuses.push(await junkTokenRequest(lms, tool.clientId, `2001:db8:5:6::${i.toString(16)}`));
    expect(count(statuses)).toEqual({ 401: 60, 429: 1 });
    expect(await junkTokenRequest(lms, tool.clientId, '2001:db8:5:7::1')).toBe(401);

    const registration = async (forwardedFor: string) =>
      (
        await lms.app.request(
          '/lti/registration',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(43)}`, 'x-forwarded-for': forwardedFor },
            body: '{}',
          },
          fromSocket(PROXY),
        )
      ).status;
    const failures: number[] = [];
    for (let i = 1; i <= 31; i++) failures.push(await registration(`2001:db8:9:9:${i.toString(16)}::1`));
    expect(count(failures)).toEqual({ 401: 30, 429: 1 });
    expect(await registration('2001:db8:9:a::1')).toBe(401);
  });

  it('count sign-ups per client', async () => {
    const lms = await newLms({ trustProxy: 'loopback' });
    const signUp = async (n: number, forwardedFor: string) => {
      const res = await lms.app.request(
        '/api/auth/register',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
          body: JSON.stringify({ name: `Learner ${n}`, email: `learner${n}@d.test`, password: PASSWORD }),
        },
        fromSocket(PROXY),
      );
      return res.status;
    };
    for (let i = 0; i < 50; i++) expect(await signUp(i, '203.0.113.1')).toBe(201);
    expect(await signUp(50, '203.0.113.1')).toBe(429);
    expect(await signUp(51, '203.0.113.2')).toBe(201);
  });
});

describe('the Node servers', () => {
  async function junkRegistrations(baseUrl: string, forwardedFor: string, count: number) {
    let status = 0;
    for (let i = 0; i < count; i++) {
      const res = await fetch(`${baseUrl}/lti/registration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(43)}`, 'x-forwarded-for': forwardedFor },
        body: '{}',
      });
      status = res.status;
      await res.arrayBuffer();
    }
    return status;
  }

  it('find the client behind a proxy with the standalone server', async () => {
    const lms = await newLms({ trustProxy: 'loopback' });
    const { port } = await lms.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    expect(await junkRegistrations(base, '203.0.113.1', 31)).toBe(429);
    expect(await junkRegistrations(base, '203.0.113.2', 1)).toBe(401);
  });

  it('find the client behind a proxy with the Node handler for Express or Fastify', async () => {
    const lms = await newLms({ trustProxy: 'loopback' });
    const server: Server = createServer((req, res) => void lms.handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await junkRegistrations(base, '203.0.113.1', 31)).toBe(429);
      expect(await junkRegistrations(base, '203.0.113.2', 1)).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
