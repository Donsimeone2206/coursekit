/**
 * Package content, outside /api: GET /content/<token>/<path in the package>.
 *
 * Package files are untrusted HTML and JavaScript, so they never run with Coursekit's origin: every
 * response carries `Content-Security-Policy: sandbox ...` without allow-same-origin (the document gets
 * an opaque origin even when opened directly in a tab), and the player frames it with the same sandbox
 * flags. Access comes from the signed, expiring token in the path (bound to the version, the user, the
 * attempt and the purpose), so relative URLs inside the package keep working without cookies.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, AppEnv } from '../context.js';
import { loadActivityAccess } from '../services/access.js';
import { isHtml, mimeFor } from './mime.js';
import { runtimeScript } from './runtime.js';
import { applyCommit, CONTENT_PREFIX, loadRuntimeContext, parseCommitBody, runtimeBoot } from './service.js';
import { packageSecret, SESSION_GRACE_SECONDS, verifyToken, type PackageToken } from './tokens.js';

export const SANDBOX_FLAGS = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
export const CONTENT_CSP = `sandbox ${SANDBOX_FLAGS}`;
const MAX_INJECT_BYTES = 20 * 1024 * 1024;

/**
 * Runs before secureHeaders (so after it on the way out): package content is framed by an opaque-origin
 * document and loaded cross-origin, so it drops X-Frame-Options and allows cross-origin embedding.
 * Only responses of the package routes (which all carry the sandbox CSP) change; /api and the web UI
 * keep the defaults.
 */
export function packageHeaderOverrides(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const path = c.req.path;
    if (path.startsWith(CONTENT_PREFIX) && c.res.headers.get('Content-Security-Policy') === CONTENT_CSP) {
      c.res.headers.delete('X-Frame-Options');
      c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    } else if (path === '/xapi' || path.startsWith('/xapi/')) {
      c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  };
}

function contentHeaders(c: Context, type: string, cache: string) {
  c.header('Content-Type', type);
  c.header('Content-Security-Policy', CONTENT_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', cache);
  c.header('X-Robots-Tag', 'noindex');
}

function denied(c: Context, status: 403 | 404, message: string) {
  contentHeaders(c, 'text/plain; charset=utf-8', 'no-store');
  return c.body(message, status);
}

/** Inserts the run-time script at the start of <head> (or as early as possible), before any other script. */
export function injectRuntime(html: Uint8Array, scriptUrl: string): Uint8Array {
  const text = Buffer.from(html).toString('latin1');
  const tag = `<script src="${scriptUrl}"></script>`;
  let at = -1;
  const head = /<head(\s[^>]*)?>/i.exec(text);
  if (head) at = head.index + head[0].length;
  else {
    const root = /<html(\s[^>]*)?>/i.exec(text);
    if (root) at = root.index + root[0].length;
    else {
      const doctype = /^(﻿|\xEF\xBB\xBF)?\s*<!doctype[^>]*>/i.exec(text);
      at = doctype ? doctype[0].length : /^(\xEF\xBB\xBF)/.test(text) ? 3 : 0;
    }
  }
  return Buffer.from(text.slice(0, at) + tag + text.slice(at), 'latin1');
}

/** Decodes the path after the token. Returns null when it is not a safe relative path. */
function packagePath(rawPath: string): string | null {
  const parts = rawPath.split('/');
  const out: string[] = [];
  for (const part of parts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (
      decoded === '' ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\\') ||
      decoded.includes('\u0000') ||
      decoded.includes('/')
    ) {
      return null;
    }
    out.push(decoded);
  }
  return out.length ? out.join('/') : null;
}

function sliceStream(stream: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done || pos > end) {
          controller.close();
          await reader.cancel().catch(() => {});
          return;
        }
        const chunkStart = pos;
        pos += value.length;
        if (pos <= start) continue;
        controller.enqueue(value.subarray(Math.max(0, start - chunkStart), Math.min(value.length, end + 1 - chunkStart)));
        return;
      }
    },
    cancel() {
      return reader.cancel();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function packageContentRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db, storage, config } = deps;

  async function token(c: Context, graceSeconds = 0): Promise<{ token: PackageToken; raw: string } | null> {
    const raw = c.req.param('token') ?? '';
    const payload = verifyToken(await packageSecret(db), raw, graceSeconds);
    if (!payload || payload.p === 'xapi') return null;
    return { token: payload, raw };
  }
  /** A session (run-time load or commit) needs the learner to still be allowed in: enrolment, visibility, groups. */
  async function stillAllowed(token: PackageToken): Promise<boolean> {
    const user = await db.selectFrom('users').selectAll().where('id', '=', token.u).executeTakeFirst();
    if (!user || user.status !== 'active') return false;
    try {
      const access = await loadActivityAccess(db, user, token.a);
      return token.p === 'preview' || access.enrolment?.role === 'student';
    } catch {
      return false;
    }
  }
  const originOf = (c: Context) => (config.publicUrl ? new URL(config.publicUrl).origin : new URL(c.req.url).origin);
  const expired = 'This link has expired or is not valid. Go back to the activity and open it again.';

  r.options('/content/:token/__coursekit/commit', (c) => {
    c.header('Content-Security-Policy', CONTENT_CSP);
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'POST');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Max-Age', '600');
    return c.body(null, 204);
  });

  r.post(
    '/content/:token/__coursekit/commit',
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) => {
        c.header('Content-Security-Policy', CONTENT_CSP);
        c.header('Access-Control-Allow-Origin', '*');
        return c.json({ ok: false, error: 'too_large' }, 413);
      },
    }),
    async (c) => {
      c.header('Content-Security-Policy', CONTENT_CSP);
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Cache-Control', 'no-store');
      // A page may stay open longer than its token lasts: commits keep working for a grace period, while
      // the learner may still open the activity and (checked in applyCommit) the attempt is in progress.
      const t = await token(c, SESSION_GRACE_SECONDS);
      const ctx = t && (await loadRuntimeContext(db, t.token));
      if (!t || !ctx) return c.json({ ok: false, error: 'invalid_token' }, 403);
      if (!(await stillAllowed(t.token))) return c.json({ ok: false, error: 'forbidden' }, 403);
      const body = parseCommitBody(await c.req.text());
      if (!body) return c.json({ ok: false, error: 'bad_request' }, 400);
      try {
        const result = await applyCommit(deps, ctx, body);
        return c.json({ ok: true, ...result });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 403 || status === 404) return c.json({ ok: false, error: 'forbidden' }, status);
        throw err;
      }
    },
  );

  r.get('/content/:token/__coursekit/runtime.js', async (c) => {
    const t = await token(c);
    const ctx = t && (await loadRuntimeContext(db, t.token));
    if (!t || !ctx || !(await stillAllowed(t.token))) return denied(c, 403, `/* ${expired} */`);
    const boot = await runtimeBoot(db, ctx, t.raw, originOf(c));
    contentHeaders(c, 'text/javascript; charset=utf-8', 'no-store');
    return c.body(runtimeScript(boot));
  });

  r.get('/content/:token/*', async (c) => {
    const t = await token(c);
    if (!t) return denied(c, 403, expired);
    const ctx = await loadRuntimeContext(db, t.token);
    if (!ctx) return denied(c, 403, expired);
    const pathname = new URL(c.req.url).pathname;
    const path = packagePath(pathname.slice(CONTENT_PREFIX.length + t.raw.length + 1));
    if (!path) return denied(c, 404, 'Not found.');
    const file =
      (await db
        .selectFrom('packageFiles')
        .select(['path', 'size'])
        .where('versionId', '=', ctx.version.id)
        .where('path', '=', path)
        .executeTakeFirst()) ??
      (await db
        .selectFrom('packageFiles')
        .select(['path', 'size'])
        .where('versionId', '=', ctx.version.id)
        .where((eb) => eb(eb.fn('lower', ['path']), '=', path.toLowerCase()))
        .executeTakeFirst());
    if (!file) return denied(c, 404, 'Not found.');
    const stream = await storage.get(ctx.version.storagePrefix + file.path);
    if (!stream) return denied(c, 404, 'Not found.');

    const type = mimeFor(file.path);
    if (isHtml(file.path) && file.size <= MAX_INJECT_BYTES) {
      const html = injectRuntime(await readAll(stream), `${CONTENT_PREFIX}${t.raw}/__coursekit/runtime.js`);
      contentHeaders(c, type, 'no-store');
      c.header('Content-Length', String(html.length));
      return c.body(html as Uint8Array<ArrayBuffer>);
    }

    contentHeaders(c, type, 'private, max-age=3600');
    c.header('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    if (range && (range[1] || range[2])) {
      const size = file.size;
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!range[1]) end = size - 1;
      if (start >= size || start > end) {
        await stream.cancel().catch(() => {});
        c.header('Content-Range', `bytes */${size}`);
        return c.body(null, 416);
      }
      start = Math.max(0, start);
      end = Math.max(start, end);
      c.header('Content-Range', `bytes ${start}-${end}/${size}`);
      c.header('Content-Length', String(end - start + 1));
      return c.body(sliceStream(stream, start, end), 206);
    }
    c.header('Content-Length', String(file.size));
    return c.body(stream);
  });

  // Everything else under /content is answered here too (never by the web app's fallback), with the sandbox.
  r.all('/content', (c) => denied(c, 404, 'Not found.'));
  r.all('/content/*', (c) => denied(c, 404, 'Not found.'));

  return r;
}
