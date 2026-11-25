import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorBody } from '../shared/types.js';
import { sessionMiddleware } from './auth/session.js';
import type { AppDeps, AppEnv } from './context.js';
import { ApiError } from './lib/http.js';
import { activityRoutes } from './routes/activities.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { badgeRoutes } from './routes/badges.js';
import { categoryRoutes } from './routes/categories.js';
import { cohortRoutes, courseCohortRoutes } from './routes/cohorts.js';
import { certificateRoutes } from './routes/certificates.js';
import { completionRoutes } from './routes/completion.js';
import { contentRoutes } from './routes/content.js';
import { courseRoutes } from './routes/courses.js';
import { emailRoutes } from './routes/email.js';
import { fileRoutes } from './routes/files.js';
import { forumRoutes } from './routes/forums.js';
import { gradeCategoryRoutes } from './routes/grade-categories.js';
import { gradeRoutes } from './routes/grades.js';
import { groupRoutes } from './routes/groups.js';
import { meRoutes } from './routes/me.js';
import { questionBankRoutes } from './routes/question-bank.js';
import { quizRoutes } from './routes/quizzes.js';

const JSON_LIMIT = 5 * 1024 * 1024;

/** Build assets and anything whose last path segment has a file extension. App routes never do. */
function isFileRequest(path: string): boolean {
  return path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path.slice(path.lastIndexOf('/') + 1));
}

function errorBody(message: string, code: string, issues?: ApiErrorBody['error']['issues']): ApiErrorBody {
  return { error: { message, code, ...(issues ? { issues } : {}) } };
}

/** Builds the Hono application: the REST API under /api and, optionally, the web UI. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.message, err.code, err.issues), err.status as ContentfulStatusCode);
    }
    if (err instanceof HTTPException) {
      const fallback = err.status === 403 ? 'This request was blocked because it came from another site.' : 'Request failed.';
      return c.json(errorBody(err.message || fallback, err.status === 403 ? 'forbidden' : 'http_error'), err.status);
    }
    console.error('[coursekit] Unhandled error:', err);
    return c.json(errorBody('Something went wrong on our side. Please try again.', 'internal_error'), 500);
  });

  app.notFound((c) => c.json(errorBody('Not found.', 'not_found'), 404));

  app.use(
    '*',
    secureHeaders({
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: 'same-origin',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }),
  );
  if (deps.config.logRequests) app.use('/api/*', logger());

  const uploadLimit = bodyLimit({
    maxSize: deps.config.maxUploadBytes + 1024 * 1024,
    onError: (c) => c.json(errorBody('That file is too large.', 'too_large'), 413),
  });
  const jsonLimit = bodyLimit({
    maxSize: JSON_LIMIT,
    onError: (c) => c.json(errorBody('Request body is too large.', 'too_large'), 413),
  });
  app.use('/api/*', (c, next) => (c.req.path === '/api/files' && c.req.method === 'POST' ? uploadLimit(c, next) : jsonLimit(c, next)));
  app.use('/api/*', csrf());
  app.use('/api/*', sessionMiddleware(deps));
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: deps.version }));
  app.route('/api/auth', authRoutes(deps));
  app.route('/api/admin', adminRoutes(deps));
  app.route('/api/categories', categoryRoutes(deps));
  app.route('/api/courses', courseRoutes(deps));
  app.route('/api/courses', contentRoutes(deps));
  app.route('/api/courses', gradeRoutes(deps));
  app.route('/api/courses', groupRoutes(deps));
  app.route('/api/courses', courseCohortRoutes(deps));
  app.route('/api/admin/cohorts', cohortRoutes(deps));
  app.route('/api/courses', gradeCategoryRoutes(deps));
  app.route('/api/activities', activityRoutes(deps));
  app.route('/api/files', fileRoutes(deps));
  app.route('/api', quizRoutes(deps));
  app.route('/api', forumRoutes(deps));
  app.route('/api', meRoutes(deps));
  // /api/email/*, /api/admin/email/* and the one-click POST /unsubscribe (outside /api: mail providers send no Origin)
  app.route('/', emailRoutes(deps));
  app.route('/api/courses', completionRoutes(deps));
  app.route('/api', certificateRoutes(deps));
  app.route('/api', badgeRoutes(deps));
  app.route('/api', questionBankRoutes(deps));
  app.all('/api/*', (c) => c.json(errorBody('Not found.', 'not_found'), 404));

  if (deps.config.webDir) {
    const webDir = deps.config.webDir;
    const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8');
    app.use(
      '/assets/*',
      serveStatic({
        root: webDir,
        onFound: (_path, c) => {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.use(
      '*',
      serveStatic({
        root: webDir,
        onFound: (path, c) => {
          if (path.endsWith('.html')) c.header('Cache-Control', 'no-cache');
        },
      }),
    );
    // Every other GET is a client-side route of the single-page app, except requests for files:
    // a missing build file (e.g. an old chunk requested by a tab opened before an upgrade) is a real 404.
    app.get('*', (c) => {
      if (isFileRequest(c.req.path)) return c.notFound();
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  return app;
}
