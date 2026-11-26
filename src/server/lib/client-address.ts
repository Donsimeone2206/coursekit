/**
 * The client's IP address, for rate limits.
 *
 * By default it is the address of the TCP connection. Behind a reverse proxy that is the proxy's
 * address, so everyone behind it would share one limit. The `trustProxy` option (COURSEKIT_TRUST_PROXY)
 * names the proxies whose X-Forwarded-For entries Coursekit believes, like Express's `trust proxy`:
 *
 * - off (the default): the connection's address; X-Forwarded-For is ignored;
 * - a list of addresses and CIDR ranges (IPv4 and IPv6, `a.b.c.d/255.255.0.0` works too) and the
 *   shortcuts `loopback`, `linklocal` and `uniquelocal`: Coursekit walks X-Forwarded-For from the
 *   right, skipping addresses in the list, and the first one that isn't listed is the client;
 * - a number n: there are n proxies in front of Coursekit (1: the client is the right-most entry);
 * - `true`: every hop is trusted and the left-most entry is the client. Clients can add entries of
 *   their own, so this is only for setups where Coursekit can't be reached except through a proxy
 *   that replaces X-Forwarded-For.
 *
 * Addresses are normalised: IPv4-mapped IPv6 addresses become IPv4, ports and IPv6 zones are dropped and
 * IPv6 is written as in RFC 5952. An entry that isn't an IP address ends the walk at the last address
 * Coursekit could trust, so a made-up entry can never become the client address.
 *
 * It works for the standalone server and for the Node handler (`lms.handler`), which both pass the
 * Node request as `c.env.incoming`. Without it (the fetch handler on other runtimes) the connection's
 * address is unknown: only a number of hops or `true` can then find the client.
 *
 * Limits use `rateLimitKey` (IPv6 by /64 network). The sign-in and sign-up limits, which can refuse a correct
 * request, use `limitAddress`: with trustProxy off it ignores requests that came through a proxy, so an
 * unconfigured proxy never makes everyone share one count.
 */
import type { Context } from 'hono';

/** What the option accepts. Strings are comma-separated lists, `true`/`false`, or a number of hops. */
export type TrustProxyOption = boolean | number | string | readonly string[];
/** Resolved: false (off), true (every hop), a number of hops, or a list of addresses, ranges and shortcuts. */
export type TrustProxySetting = boolean | number | readonly string[];

/** 16 bytes; IPv4 addresses are stored IPv4-mapped (::ffff:a.b.c.d). */
type Address = Uint8Array;

interface Subnet {
  bytes: Address;
  /** Prefix length on the 128-bit form (an IPv4 /24 is 120). */
  bits: number;
}

export const TRUST_PROXY_SHORTCUTS: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.1/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

const MAX_HOPS = 100;

function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    // No leading zeros: "010" is octal to some parsers and decimal to others.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function mapped(v4: number[]): Address {
  const bytes = new Uint8Array(16);
  bytes[10] = 0xff;
  bytes[11] = 0xff;
  bytes.set(v4, 12);
  return bytes;
}

function parseGroups(part: string, last: boolean): number[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  const out: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (group.includes('.')) {
      // An embedded IPv4 address can only be the last 32 bits.
      if (!last || i !== groups.length - 1) return null;
      const v4 = parseIPv4(group);
      if (!v4) return null;
      out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
  }
  return out;
}

function parseIPv6(text: string): Address | null {
  if (text.length > 45) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? parseGroups(halves[1]!, true) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

/** Parses a bare IPv4 or IPv6 address (no port, brackets or zone). */
function parseIp(text: string): Address | null {
  if (text.includes(':')) return parseIPv6(text);
  const v4 = parseIPv4(text);
  return v4 ? mapped(v4) : null;
}

function isV4(bytes: Address): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function formatIp(bytes: Address): string {
  if (isV4(bytes)) return Array.from(bytes.subarray(12)).join('.');
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  // RFC 5952: lower case, no leading zeros, the longest run of two or more zero groups (the first if tied) as "::".
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (list: number[]) => list.map((g) => g.toString(16)).join(':');
  if (bestStart === -1) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/** Reads an address as proxies and sockets write it: with a port, in brackets, with an IPv6 zone. */
function readAddress(raw: unknown): Address | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text || text.length > 64) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1]!;
  else if (/^[\d.]+:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(':'));
  const zone = text.indexOf('%');
  if (zone !== -1) {
    // An IPv6 zone (fe80::1%eth0) names a local interface: dropped.
    if (!text.includes(':') || !/^%[\w.~-]{1,32}$/.test(text.slice(zone))) return null;
    text = text.slice(0, zone);
  }
  return parseIp(text);
}

/** A normalised IP address, or null when `raw` isn't one. */
export function normalizeAddress(raw: unknown): string | null {
  const bytes = readAddress(raw);
  return bytes ? formatIp(bytes) : null;
}

/** IPv4 netmask (255.255.240.0) to a prefix length, or -1 when the ones aren't contiguous. */
function maskBits(mask: number[]): number {
  const value = ((mask[0]! << 24) | (mask[1]! << 16) | (mask[2]! << 8) | mask[3]!) >>> 0;
  const hostBits = ~value >>> 0;
  // Ones then zeros: the host part plus one is a power of two.
  if ((hostBits & (hostBits + 1)) !== 0) return -1;
  return hostBits === 0 ? 32 : Math.clz32(hostBits);
}

function parseSubnet(entry: string): Subnet | null {
  const slash = entry.indexOf('/');
  const addressText = slash === -1 ? entry : entry.slice(0, slash);
  const range = slash === -1 ? null : entry.slice(slash + 1);
  const bytes = parseIp(addressText);
  if (!bytes) return null;
  const v6Text = addressText.includes(':');
  const max = v6Text ? 128 : 32;
  let bits = max;
  if (range !== null) {
    if (/^\d{1,3}$/.test(range)) bits = Number(range);
    else if (!v6Text && parseIPv4(range)) bits = maskBits(parseIPv4(range)!);
    else return null;
    if (bits < 0 || bits > max) return null;
  }
  return { bytes, bits: v6Text ? bits : 96 + bits };
}

function inSubnet(subnet: Subnet, address: Address): boolean {
  const whole = subnet.bits >> 3;
  for (let i = 0; i < whole; i++) if (subnet.bytes[i] !== address[i]) return false;
  const rest = subnet.bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (subnet.bytes[whole]! & mask) === (address[whole]! & mask);
}

function invalid(label: string, detail: string): Error {
  return new Error(
    `${label}: ${detail} Use a comma-separated list of proxy addresses and CIDR ranges (or loopback, linklocal, uniquelocal), a number of proxies, or true.`,
  );
}

/**
 * Checks and normalises the trustProxy option (or COURSEKIT_TRUST_PROXY). Throws on anything it can't
 * read, so a typo stops Coursekit from starting instead of silently trusting nothing (or everything).
 */
export function resolveTrustProxy(value: unknown, label = 'trustProxy'): TrustProxySetting {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > MAX_HOPS)
      throw invalid(label, `${value} is not a number of proxies (0 to ${MAX_HOPS}).`);
    return value === 0 ? false : value;
  }
  let entries: unknown[];
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === '' || text === 'false') return false;
    if (text === 'true') return true;
    if (/^\d+$/.test(text)) return resolveTrustProxy(Number(text), label);
    entries = text.split(',');
  } else if (Array.isArray(value)) {
    entries = value;
  } else {
    throw invalid(label, 'it must be true, false, a number or a list of addresses.');
  }
  const list: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') throw invalid(label, 'every entry must be a string.');
    const item = entry.trim().toLowerCase();
    if (!item) continue;
    if (!Object.hasOwn(TRUST_PROXY_SHORTCUTS, item) && !parseSubnet(item)) {
      throw invalid(label, `"${entry.trim()}" is not an IP address, a CIDR range or one of loopback, linklocal and uniquelocal.`);
    }
    list.push(item);
  }
  return list.length ? Object.freeze(list) : false;
}

const compiled = new WeakMap<readonly string[], Subnet[]>();

function subnetsOf(list: readonly string[]): Subnet[] {
  let subnets = compiled.get(list);
  if (!subnets) {
    // Entries that can't be read are left out (resolveTrustProxy refuses them; a hand-made config might not).
    subnets = list
      .flatMap((item) => (Object.hasOwn(TRUST_PROXY_SHORTCUTS, item) ? TRUST_PROXY_SHORTCUTS[item]! : [item]))
      .flatMap((item) => parseSubnet(item) ?? []);
    compiled.set(list, subnets);
  }
  return subnets;
}

/** True when `address` (any form normalizeAddress reads) is in one of the CIDR ranges or shortcuts. */
export function addressInRanges(address: string, ranges: readonly string[]): boolean {
  const bytes = readAddress(address);
  return !!bytes && subnetsOf(ranges).some((s) => inSubnet(s, bytes));
}

/** Whether the hop at `index` (0 = the connection) with this address is a trusted proxy. */
function trusted(setting: TrustProxySetting, address: Address | null, index: number): boolean {
  if (setting === true) return true;
  if (setting === false) return false;
  if (typeof setting === 'number') return index < setting;
  return !!address && subnetsOf(setting).some((s) => inSubnet(s, address));
}

/** The connection's address, from the Node request the server or `lms.handler` passed as c.env.incoming. */
function socketAddress(c: Context): unknown {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

/** Headers a reverse proxy adds. While trustProxy is off, any of them means the connection is a proxy's. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'] as const;

const forwardedByProxy = (c: Context) => PROXY_HEADERS.some((name) => !!c.req.header(name));

const LOOPBACK: readonly string[] = Object.freeze(['loopback']);

let warned = false;

/**
 * The client's normalised IP address, or null when it can't be known. See the top of this file for how
 * `trustProxy` changes it.
 */
export function clientAddress(c: Context, config: { trustProxy: TrustProxySetting }): string | null {
  const setting = config.trustProxy;
  let current = readAddress(socketAddress(c));
  const forwarded = c.req.header('x-forwarded-for');
  if (setting === false) {
    if (!warned && forwardedByProxy(c)) {
      warned = true;
      console.warn(
        '[coursekit] Requests carry X-Forwarded-For, Forwarded or X-Real-IP, but trustProxy (COURSEKIT_TRUST_PROXY) is off, so Coursekit cannot tell the clients behind the proxy apart: sign-ins and sign-ups only get the limits per email, and failed LTI requests share one limit. Set it to your proxy, for example COURSEKIT_TRUST_PROXY=loopback, and have the proxy send X-Forwarded-For.',
      );
    }
    return current ? formatIp(current) : null;
  }
  const hops = forwarded ? forwarded.split(',') : [];
  for (let index = 0; index <= MAX_HOPS && trusted(setting, current, index); index++) {
    const raw = hops.pop();
    if (raw === undefined) break; // the left end: the furthest address is the client
    const next = readAddress(raw);
    if (!next) break; // not an address: stop at the last one that could be trusted
    current = next;
  }
  return current ? formatIp(current) : null;
}

/**
 * The key for a limit per client address: IPv4 addresses (IPv4-mapped ones too) one by one, IPv6 addresses by
 * their /64 network, since one host is usually given a whole /64 and could otherwise pick a new address for every
 * request. Anything else (such as 'unknown') is returned unchanged.
 */
export function rateLimitKey(address: string): string {
  const bytes = readAddress(address);
  if (!bytes) return address;
  if (isV4(bytes)) return formatIp(bytes);
  const network = new Uint8Array(16);
  network.set(bytes.subarray(0, 8));
  return `${formatIp(network)}/64`;
}

/**
 * The key for the limits per client address that can refuse a correct request (sign-ins and sign-ups), or null
 * when the address doesn't tell clients apart, so that only the limits per email apply, as before 0.4.0.
 *
 * With trustProxy off (the default), that is the case for requests a reverse proxy forwarded (X-Forwarded-For,
 * Forwarded or X-Real-IP) and for requests from this machine (loopback, such as a proxy that sends none of
 * those headers): everyone behind the proxy would share one count, so anyone could lock everyone else out.
 * A client that connects directly can skip these limits by sending such a header; set trustProxy to stop that.
 */
export function limitAddress(c: Context, config: { trustProxy: TrustProxySetting }): string | null {
  const address = clientAddress(c, config);
  if (!address) return null;
  if (config.trustProxy === false && (forwardedByProxy(c) || addressInRanges(address, LOOPBACK))) return null;
  return rateLimitKey(address);
}
