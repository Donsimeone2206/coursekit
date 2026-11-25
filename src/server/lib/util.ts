import { createHash, randomBytes } from 'node:crypto';

// Crockford base32: 32 symbols, so every random byte maps without bias.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Random, URL-safe identifier (80 bits by default). */
export function newId(length = 16): string {
  const bytes = randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) id += ALPHABET[bytes[i]! & 31];
  return id;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function now(): string {
  return new Date().toISOString();
}

export function addDays(date: Date | string, days: number): Date {
  const d = new Date(date);
  d.setTime(d.getTime() + days * 86_400_000);
  return d;
}

export function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || fallback;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toBool(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

/** Postgres returns bigint/numeric aggregates as strings; SQLite returns numbers. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function excerpt(markdown: string, length = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

/**
 * Pattern for a portable, case-insensitive "contains" search: compare against lower(column).
 * (SQLite has no default LIKE escape character, so wildcards in the query are left as-is.)
 */
export function likePattern(q: string): string {
  return `%${q.trim().toLowerCase()}%`;
}
