/**
 * Email templates: table-based HTML with inline styles (readable in Gmail, Outlook and Apple Mail),
 * a dark-mode stylesheet for the clients that support one, and a plain-text part. Every dynamic value
 * is escaped; links are absolute and only present when the site's public URL is known.
 */
import { DEFAULT_BRAND_COLOR } from '../../../shared/constants.js';
import { EMAIL_CATEGORIES, type EmailCategoryId } from '../../../shared/email.js';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const LIGHT = { page: '#f4f5f8', card: '#ffffff', border: '#e3e6ec', heading: '#1c2030', body: '#3b4152', muted: '#6b7182' };
const DARK = { page: '#12141b', card: '#1b1d26', border: '#2c303c', heading: '#eceef3', body: '#c9ccd6', muted: '#9aa0ad' };

export interface EmailBrand {
  name: string;
  brandColor: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** Links shared by every email to one person. Null when the site has no public URL. */
export interface EmailLinks {
  preferences: string | null;
  unsubscribe: string | null;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** A single-line header value: no CR/LF or other control characters, collapsed spaces, bounded length. */
export function headerText(value: string, max = 250): string {
  const line = value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Plain text for an email body: control characters removed, line breaks kept. */
function plain(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

/**
 * Notification bodies can be the start of a Markdown post (announcements do this): drop the common
 * syntax so emails read as plain text. Paired markers only, so "snake_case" and "5 * 3" survive.
 */
export function markdownToText(value: string): string {
  return value
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}|>)[ \t]?/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}

/** The site's public URL without a trailing slash, or null when it is missing or not http(s). */
export function normalizeBaseUrl(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** An absolute link for an app path such as "/courses/x", or null without a public URL. */
export function absoluteUrl(base: string | null, path: string | null | undefined): string | null {
  if (!base || !path) return null;
  if (/^https?:\/\//i.test(path)) {
    try {
      return new URL(path).toString();
    } catch {
      return null;
    }
  }
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  try {
    return new URL(base + path).toString();
  } catch {
    return null;
  }
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mixes a colour with white (amount > 0) or black (amount < 0). */
function mix(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const target = amount > 0 ? 255 : 0;
  const a = Math.abs(amount);
  const ch = (c: number) => Math.round(c + (target - c) * a);
  return `#${((1 << 24) | (ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1)}`;
}

/** Brand colours for buttons and links in light and dark mode, all with readable contrast. */
export function brandPalette(color: string) {
  const brand = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_BRAND_COLOR;
  const onBrand = contrast(brand, '#ffffff') >= contrast(brand, '#0b0d12') ? '#ffffff' : '#0b0d12';
  let link = brand;
  for (let a = 0.1; contrast(link, LIGHT.card) < 4.5 && a <= 0.9; a += 0.1) link = mix(brand, -a);
  let darkLink = brand;
  for (let a = 0.1; contrast(darkLink, DARK.card) < 4.5 && a <= 0.9; a += 0.1) darkLink = mix(brand, a);
  return { brand, onBrand, link, darkLink };
}

function paragraphs(text: string, options: { muted?: boolean; margin?: string } = {}): string {
  const cls = options.muted ? 'ck-muted' : 'ck-body';
  const color = options.muted ? LIGHT.muted : LIGHT.body;
  return plain(text)
    .split(/\n{2,}/)
    .filter(Boolean)
    .map(
      (p) =>
        `<p class="${cls}" style="margin:${options.margin ?? '0 0 14px'};font-family:${FONT};font-size:15px;line-height:1.6;color:${color};">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

interface LayoutInput {
  brand: EmailBrand;
  /** Small label above the heading, e.g. the notification category. */
  eyebrow?: string | null;
  heading: string;
  /** Hidden preview text that inboxes show next to the subject. */
  preheader: string;
  /** Escaped HTML for the main content. */
  bodyHtml: string;
  bodyText: string;
  action?: { label: string; url: string } | null;
  /** Why the person gets this email (plain text). */
  reason: string;
  links: EmailLinks;
}

function layout(input: LayoutInput): { html: string; text: string } {
  const p = brandPalette(input.brand.brandColor);
  const name = escapeHtml(input.brand.name);
  const initial = escapeHtml((Array.from(input.brand.name.trim())[0] ?? 'C').toUpperCase());
  const footerLink = (url: string, label: string) =>
    `<a href="${escapeHtml(url)}" class="ck-muted" style="color:${LIGHT.muted};text-decoration:underline;">${label}</a>`;
  const footerLinks = [
    input.links.preferences ? footerLink(input.links.preferences, 'Manage email preferences') : null,
    input.links.unsubscribe ? footerLink(input.links.unsubscribe, 'Unsubscribe') : null,
  ].filter(Boolean);

  const button = input.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px;"><tr><td style="border-radius:8px;background-color:${p.brand};">` +
      `<a href="${escapeHtml(input.action.url)}" style="display:inline-block;padding:11px 20px;font-family:${FONT};font-size:14px;font-weight:600;line-height:18px;color:${p.onBrand};text-decoration:none;border-radius:8px;">${escapeHtml(input.action.label)}</a>` +
      `</td></tr></table>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.heading)}</title>
<style>
  body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; }
  a { color: ${p.link}; }
  .ck-link { color: ${p.link}; }
  @media (prefers-color-scheme: dark) {
    .ck-page { background-color: ${DARK.page} !important; }
    .ck-card { background-color: ${DARK.card} !important; border-color: ${DARK.border} !important; }
    .ck-heading { color: ${DARK.heading} !important; }
    .ck-body { color: ${DARK.body} !important; }
    .ck-muted { color: ${DARK.muted} !important; }
    .ck-link { color: ${p.darkLink} !important; }
    .ck-rule { border-color: ${DARK.border} !important; }
  }
  [data-ogsc] .ck-heading { color: ${DARK.heading} !important; }
  [data-ogsc] .ck-body { color: ${DARK.body} !important; }
  [data-ogsc] .ck-muted { color: ${DARK.muted} !important; }
  [data-ogsc] .ck-link { color: ${p.darkLink} !important; }
  [data-ogsb] .ck-page { background-color: ${DARK.page} !important; }
  [data-ogsb] .ck-card { background-color: ${DARK.card} !important; }
  @media (max-width: 600px) {
    .ck-pad { padding: 24px 20px !important; }
  }
</style>
</head>
<body class="ck-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="ck-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${LIGHT.page};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 4px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;border-radius:9px;background-color:${p.brand};color:${p.onBrand};font-family:${FONT};font-size:16px;font-weight:700;line-height:32px;">${initial}</td>
<td class="ck-heading" style="padding-left:10px;font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;color:${LIGHT.heading};">${name}</td>
</tr></table>
</td></tr>
<tr><td class="ck-card ck-pad" style="background-color:${LIGHT.card};border:1px solid ${LIGHT.border};border-radius:14px;padding:32px;">
${input.eyebrow ? `<p class="ck-muted" style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:600;line-height:16px;letter-spacing:0.04em;text-transform:uppercase;color:${LIGHT.muted};">${escapeHtml(input.eyebrow)}</p>` : ''}
<h1 class="ck-heading" style="margin:0 0 14px;font-family:${FONT};font-size:20px;font-weight:600;line-height:28px;color:${LIGHT.heading};">${escapeHtml(input.heading)}</h1>
${input.bodyHtml}
${button}
</td></tr>
<tr><td class="ck-muted" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:19px;color:${LIGHT.muted};">
${escapeHtml(input.reason)}${footerLinks.length ? `<br>${footerLinks.join(' &middot; ')}` : ''}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  const text = [
    input.brand.name,
    '',
    ...(input.eyebrow ? [input.eyebrow.toUpperCase()] : []),
    input.heading,
    '',
    plain(input.bodyText),
    ...(input.action ? ['', `${input.action.label}: ${input.action.url}`] : []),
    '',
    '--',
    input.reason,
    ...(input.links.preferences ? [`Manage email preferences: ${input.links.preferences}`] : []),
    ...(input.links.unsubscribe ? [`Unsubscribe: ${input.links.unsubscribe}`] : []),
    '',
  ].join('\n');

  return { html, text };
}

/** List-Unsubscribe headers (RFC 2369 and RFC 8058 one-click), plus headers that keep auto-replies away. */
export function emailHeaders(unsubscribeUrl: string | null): Record<string, string> {
  return {
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'All',
    ...(unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
  };
}

function categoryLabel(id: EmailCategoryId): string {
  return EMAIL_CATEGORIES.find((c) => c.id === id)?.label ?? 'Updates';
}

export interface NotificationEmailInput {
  brand: EmailBrand;
  links: EmailLinks;
  base: string | null;
  title: string;
  body: string;
  link: string | null;
  category: EmailCategoryId;
}

export function renderNotificationEmail(input: NotificationEmailInput): RenderedEmail {
  const url = absoluteUrl(input.base, input.link);
  const site = input.brand.name;
  const body = plain(markdownToText(input.body));
  const hint = input.link && !url ? `Sign in to ${site} to see the details.` : '';
  const { html, text } = layout({
    brand: input.brand,
    eyebrow: categoryLabel(input.category),
    heading: headerText(input.title, 200),
    preheader: body || input.title,
    bodyHtml: paragraphs([body, hint].filter(Boolean).join('\n\n')),
    bodyText: [body, hint].filter(Boolean).join('\n\n'),
    action: url ? { label: `View in ${site}`, url } : null,
    reason: input.links.preferences
      ? `You're receiving this because email notifications are on for your ${site} account.`
      : `You're receiving this because email notifications are on for your ${site} account. To change them, sign in and open your profile.`,
    links: input.links,
  });
  return { subject: headerText(input.title, 200), html, text, headers: emailHeaders(input.links.unsubscribe) };
}

export interface DigestItem {
  title: string;
  body: string;
  link: string | null;
  category: EmailCategoryId;
  createdAt: string;
}

export interface DigestEmailInput {
  brand: EmailBrand;
  links: EmailLinks;
  base: string | null;
  period: 'daily' | 'weekly';
  /** Start of the period covered (ISO): the previous digest, or one period ago. */
  since: string;
  /** Newest first. Only the first `limit` are listed. */
  items: DigestItem[];
  timezone: string;
  limit?: number;
}

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
      new Date(iso),
    );
  } catch {
    return new Date(iso).toUTCString();
  }
}

export function renderDigestEmail(input: DigestEmailInput): RenderedEmail {
  const limit = input.limit ?? 20;
  const total = input.items.length;
  const shown = input.items.slice(0, limit);
  const site = input.brand.name;
  const word = total === 1 ? 'notification' : 'notifications';
  const intro = `You have ${total} new ${word} since ${formatWhen(input.since, input.timezone)}.`;

  const linkColor = brandPalette(input.brand.brandColor).link;
  const htmlParts = [paragraphs(intro)];
  const textParts = [intro];
  for (const category of EMAIL_CATEGORIES) {
    const items = shown.filter((i) => i.category === category.id);
    if (!items.length) continue;
    htmlParts.push(
      `<h2 class="ck-heading" style="margin:22px 0 4px;font-family:${FONT};font-size:14px;font-weight:600;line-height:20px;color:${LIGHT.heading};">${escapeHtml(category.label)}</h2>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    );
    textParts.push('', category.label.toUpperCase());
    for (const item of items) {
      const url = absoluteUrl(input.base, item.link);
      const title = escapeHtml(headerText(item.title, 200));
      const when = formatWhen(item.createdAt, input.timezone);
      const body = headerText(markdownToText(item.body), 220);
      htmlParts.push(
        `<tr><td class="ck-rule" style="padding:12px 0;border-top:1px solid ${LIGHT.border};">` +
          (url
            ? `<a href="${escapeHtml(url)}" class="ck-link" style="font-family:${FONT};font-size:15px;font-weight:600;line-height:22px;color:${linkColor};text-decoration:none;">${title}</a>`
            : `<span class="ck-heading" style="font-family:${FONT};font-size:15px;font-weight:600;line-height:22px;color:${LIGHT.heading};">${title}</span>`) +
          (body
            ? `<div class="ck-body" style="margin-top:2px;font-family:${FONT};font-size:14px;line-height:21px;color:${LIGHT.body};">${escapeHtml(body)}</div>`
            : '') +
          `<div class="ck-muted" style="margin-top:4px;font-family:${FONT};font-size:12px;line-height:16px;color:${LIGHT.muted};">${escapeHtml(when)}</div>` +
          `</td></tr>`,
      );
      textParts.push(`- ${headerText(item.title, 200)} (${when})`, ...(body ? [`  ${body}`] : []), ...(url ? [`  ${url}`] : []));
    }
    htmlParts.push('</table>');
  }
  if (total > shown.length) {
    const more = `And ${total - shown.length} more.`;
    htmlParts.push(paragraphs(more, { muted: true, margin: '16px 0 0' }));
    textParts.push('', more);
  }

  const allUrl = absoluteUrl(input.base, '/notifications');
  const heading = input.period === 'daily' ? 'Your daily digest' : 'Your weekly digest';
  const first = headerText(shown[0]?.title ?? '', 120);
  const { html, text } = layout({
    brand: input.brand,
    heading,
    preheader: intro,
    bodyHtml: htmlParts.join(''),
    bodyText: textParts.join('\n'),
    action: allUrl ? { label: 'View all notifications', url: allUrl } : null,
    reason: `You're receiving this ${input.period} digest because of your email preferences on ${site}.`,
    links: input.links,
  });
  const subject = headerText(`${heading}: ${first}${total > 1 ? ` and ${total - 1} more` : ''}`, 200);
  return { subject, html, text, headers: emailHeaders(input.links.unsubscribe) };
}

export function renderTestEmail(input: {
  brand: EmailBrand;
  links: EmailLinks;
  transportName: string;
  sentAt: string;
  timezone: string;
}): RenderedEmail {
  const site = input.brand.name;
  const body = `This is a test message from ${site}. If you can read it, email delivery is set up correctly.\n\nSent through ${input.transportName} on ${formatWhen(input.sentAt, input.timezone)}.`;
  const { html, text } = layout({
    brand: input.brand,
    heading: 'Email is working',
    preheader: `A test message from ${site}.`,
    bodyHtml: paragraphs(body),
    bodyText: body,
    reason: `An administrator of ${site} sent this test from the email settings page.`,
    links: input.links,
  });
  return { subject: headerText(`Test email from ${site}`), html, text, headers: emailHeaders(input.links.unsubscribe) };
}
