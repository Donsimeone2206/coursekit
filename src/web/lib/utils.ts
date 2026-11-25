import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const sameYear = (d: Date) => d.getFullYear() === new Date().getFullYear();

export function formatDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return '';
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear(d) ? {} : { year: 'numeric' }),
    ...opts,
  }).format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return formatDate(iso, { hour: 'numeric', minute: '2-digit' });
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms || unit === 'minute') {
      const value = Math.round(diff / ms);
      if (unit === 'minute' && value === 0) return 'just now';
      return rtf.format(value, unit);
    }
  }
  return '';
}

/** "Due tomorrow at 11:59 PM", "Due in 4 days", "2 days overdue" */
export function dueLabel(iso: string, done = false): string {
  const due = new Date(iso);
  const diff = due.getTime() - Date.now();
  const day = 86_400_000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayIndex = Math.floor((due.getTime() - startOfToday.getTime()) / day);
  if (diff < 0 && !done) {
    const days = Math.floor(-diff / day);
    return days === 0 ? `Overdue since ${formatTime(iso)}` : `${days} day${days === 1 ? '' : 's'} overdue`;
  }
  if (dayIndex === 0) return `Due today at ${formatTime(iso)}`;
  if (dayIndex === 1) return `Due tomorrow at ${formatTime(iso)}`;
  if (dayIndex > 1 && dayIndex < 7)
    return `Due ${new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(due)} at ${formatTime(iso)}`;
  return `Due ${formatDateTime(iso)}`;
}

export function isPast(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '–';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(/\.0+$/, '');
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}

const AVATAR_COLORS = [
  'bg-rose-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-teal-500',
  'bg-sky-500',
  'bg-indigo-500',
  'bg-violet-500',
  'bg-fuchsia-500',
  'bg-pink-500',
];

export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

/** ISO string → value for <input type="datetime-local"> in the user's time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toDateInput(iso: string | null | undefined): string {
  return iso ? toLocalInput(iso).slice(0, 10) : '';
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Text colour (near-black or white) with the higher WCAG contrast on the given background. */
export function contrastText(hex: string): string {
  const lum = luminance(hex);
  if (lum == null) return '#ffffff';
  const onWhite = 1.05 / (lum + 0.05);
  const onDark = (lum + 0.05) / 0.055;
  return onDark > onWhite ? '#0b0d12' : '#ffffff';
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return 1;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The lightest-needed tint of `hex` that reads at 4.5:1 on the dark card surface. */
export function darkModeTone(hex: string, surface = '#1b1d26'): string {
  for (let amount = 0.3; amount <= 0.9; amount += 0.05) {
    const t = tint(hex, amount);
    if (contrastRatio(t, surface) >= 4.5) return t;
  }
  return tint(hex, 0.9);
}

/** Mix a hex colour with white (amount 0..1), used for the dark-mode brand tone. */
export function tint(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Plain-text preview of markdown, e.g. for cards and notifications. */
export function excerptOf(markdown: string, length = 140) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
