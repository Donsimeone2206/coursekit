/**
 * Small server-rendered pages for the LTI browser flows (auto-submitting forms, errors, the deep
 * linking result). Every value is HTML-escaped; inline scripts and styles carry a per-response nonce
 * allowed by the page's Content-Security-Policy.
 */
import type { Context } from 'hono';
import { randomToken } from '../../lib/util.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--fg:#151826;--muted:#5d6275;--border:#e3e5ee;--primary:#4f46e5;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#12131a;--card:#1b1d26;--fg:#eceef6;--muted:#a3a8bb;--border:#2c2f3c;--primary:#8b85ff;--danger:#ff8f86}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:460px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;box-shadow:0 1px 2px rgb(0 0 0/.04)}
h1{font-size:18px;margin:0 0 6px}p{margin:8px 0;color:var(--muted)}ul{margin:12px 0;padding-left:20px}li{margin:4px 0}
.error h1{color:var(--danger)}a{color:var(--primary)}
button,.button{display:inline-flex;align-items:center;justify-content:center;margin-top:16px;height:38px;padding:0 16px;border:0;border-radius:8px;background:var(--primary);color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.spinner{width:22px;height:22px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite;margin-bottom:12px}
@keyframes spin{to{transform:rotate(360deg)}}`;

export interface HtmlPageOptions {
  title: string;
  /** Inner HTML of <main>; callers escape their values. */
  body: string;
  /** Inline script, run with the page's nonce. */
  script?: string;
  status?: 200 | 400 | 401 | 403 | 404 | 429 | 500;
  className?: string;
}

/** Sends a self-contained page: no caching, inline code only through the nonce, framed only by Coursekit itself. */
export function sendPage(c: Context, options: HtmlPageOptions): Response {
  const nonce = randomToken(16);
  c.header('Cache-Control', 'no-store');
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self'`,
  );
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main class="${escapeHtml(options.className ?? '')}">${options.body}</main>
${options.script ? `<script nonce="${nonce}">${options.script}</script>` : ''}
</body>
</html>`;
  return c.html(html, options.status ?? 200);
}

/** A page that posts `fields` to `action` straight away (with a button for browsers without JavaScript). */
export function sendAutoPost(c: Context, action: string, fields: Record<string, string | null | undefined>, message: string): Response {
  const inputs = Object.entries(fields)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  return sendPage(c, {
    title: message,
    body: `<div class="spinner" role="status" aria-label="Loading"></div><h1>${escapeHtml(message)}</h1>
<form id="lti-form" method="post" action="${escapeHtml(action)}">${inputs}<noscript><button type="submit">Continue</button></noscript></form>`,
    script: `document.getElementById('lti-form').submit();`,
  });
}

export function sendError(
  c: Context,
  message: string,
  status: HtmlPageOptions['status'] = 400,
  title = "We couldn't open this tool",
): Response {
  return sendPage(c, {
    title,
    className: 'error',
    status,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
  });
}
