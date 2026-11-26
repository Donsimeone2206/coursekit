/**
 * Open Badges export, mounted at the root:
 * - /openbadges/*: the public documents (Open Badges 2.0 hosted verification, Open Badges 3.0 credentials, status
 *   list, signing key and badge images). Read-only, no session, CORS for GET and embeddable from other sites.
 * - /api/badges/:badgeId/share and /api/me/badge-shares: the recipient shares a badge they hold, or stops sharing it.
 * - /api/open-badges/shares/:shareId: what the public verification page shows (no sign-in).
 * - /api/admin/open-badges: the issuer details, for administrators.
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  OPEN_BADGES_UNAVAILABLE,
  type BadgeShare,
  type BadgeShareStatus,
  type MyBadgeShare,
  type OpenBadgesAdminInfo,
  type SharedBadgeVerification,
} from '../../shared/open-badges.js';
import { requireAdmin, requireUser, type AppDeps, type AppEnv } from '../context.js';
import type { BadgeRow } from '../db/schema-completion.js';
import type { OpenBadgeShareRow } from '../db/schema-open-badges.js';
import { conflict, forbidden, notFound, readBody } from '../lib/http.js';
import { slugify } from '../lib/util.js';
import { badgeSvg, bakeSvg } from '../services/open-badges/art.js';
import {
  badgeText,
  ob2Assertion,
  ob2BadgeClass,
  ob2Issuer,
  ob2Revoked,
  ob3Achievement,
  ob3Profile,
  OB3_CONTEXT,
  openBadgeUrls,
  publicJwk,
  signedCredential,
  signedStatusList,
  VC2_CONTEXT,
  type OpenBadgeUrls,
} from '../services/open-badges/documents.js';
import { defaultIssuerEmail, getIssuerSettings, publicBase, resolveIssuer, saveIssuerSettings } from '../services/open-badges/issuer.js';
import { issuerKey } from '../services/open-badges/keys.js';
import { getSiteSettings } from '../services/settings.js';
import {
  activeAward,
  badgeIsShared,
  countActiveShares,
  createShare,
  currentShare,
  loadShareState,
  shareStatus,
  withdrawShares,
  type ShareState,
} from '../services/open-badges/shares.js';

const BADGE_ID_RE = /^[0-9a-z]{1,40}$/;
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const issuerSchema = z.object({
  name: z.string().trim().max(120),
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.union([z.literal(''), z.email('Enter a valid email address')])),
  description: z.string().trim().max(1000),
});

export function openBadgeRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  function linksFor(urls: OpenBadgeUrls, share: OpenBadgeShareRow): BadgeShare {
    return {
      id: share.id,
      sharedAt: share.createdAt,
      links: {
        assertion: urls.ob2Assertion(share.id),
        page: urls.page(share.id),
        badgeImage: urls.ob2BakedImage(share.id),
        credential: urls.ob3Credential(share.id),
        credentialImage: urls.ob3BakedImage(share.id),
      },
    };
  }

  async function shareStatusFor(badgeId: string, userId: string): Promise<BadgeShareStatus> {
    const base = publicBase(deps);
    const award = BADGE_ID_RE.test(badgeId) ? await activeAward(db, badgeId, userId) : undefined;
    const share = award && base ? await currentShare(db, badgeId, userId) : undefined;
    return {
      earned: !!award,
      unavailableReason: base ? null : OPEN_BADGES_UNAVAILABLE,
      share: share && base ? linksFor(openBadgeUrls(base), share) : null,
    };
  }

  // ---- public documents ----------------------------------------------------------------------------

  r.use('/openbadges/*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'], maxAge: 86_400 }));
  r.use('/openbadges/*', async (c, next) => {
    await next();
    // Public, credential-free documents meant to be fetched and embedded by backpacks and verifiers on other sites.
    c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-cache');
  });

  const missing = (c: Context, what = 'Page') => c.json({ error: { message: `${what} not found.`, code: 'not_found' } }, 404);

  async function publicContext() {
    const base = publicBase(deps);
    if (!base) return null;
    return { urls: openBadgeUrls(base), issuer: await resolveIssuer(deps, base) };
  }

  /** A badge's public details, only while someone shares it. */
  async function sharedBadge(badgeId: string | undefined) {
    if (!badgeId || !BADGE_ID_RE.test(badgeId) || !(await badgeIsShared(db, badgeId))) return null;
    const badge = await db.selectFrom('badges').selectAll().where('id', '=', badgeId).executeTakeFirst();
    if (!badge) return null;
    return { badge, courseTitle: await courseTitle(badge) };
  }

  /** The title of the badge's course, only while the course is published (drafts and archived courses stay private). */
  async function courseTitle(badge: BadgeRow): Promise<string | null> {
    if (!badge.courseId) return null;
    const course = await db
      .selectFrom('courses')
      .select('title')
      .where('id', '=', badge.courseId)
      .where('visibility', '=', 'published')
      .executeTakeFirst();
    return course?.title ?? null;
  }

  function svgResponse(c: Context, svg: string, filename: string) {
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    c.header('Content-Security-Policy', SVG_CSP);
    if (c.req.query('download') !== undefined) c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(svg);
  }

  function revoked(c: Context, urls: OpenBadgeUrls, shareId: string, reason: string) {
    return c.json(ob2Revoked(urls, shareId, reason), 410);
  }

  r.get('/openbadges/v2/issuer', async (c) => {
    const ctx = await publicContext();
    if (!ctx) return missing(c);
    return c.json(ob2Issuer(ctx.urls, ctx.issuer));
  });

  r.get('/openbadges/v3/issuer', async (c) => {
    const ctx = await publicContext();
    if (!ctx) return missing(c);
    return c.json({ '@context': [VC2_CONTEXT, OB3_CONTEXT], ...ob3Profile(ctx.urls, ctx.issuer) });
  });

  r.get('/openbadges/v2/badges/:badgeId', async (c) => {
    const ctx = await publicContext();
    const found = ctx && (await sharedBadge(c.req.param('badgeId')));
    if (!ctx || !found) return missing(c, 'Badge');
    const text = await badgeText(db, found.badge, found.courseTitle, ctx.issuer.name);
    return c.json(ob2BadgeClass(ctx.urls, found.badge, text));
  });

  r.get('/openbadges/v2/badges/:badgeId/image.svg', async (c) => {
    const ctx = await publicContext();
    const found = ctx && (await sharedBadge(c.req.param('badgeId')));
    if (!ctx || !found) return missing(c, 'Badge');
    return svgResponse(c, badgeSvg(found.badge), `${slugify(found.badge.name, 'badge')}.svg`);
  });

  r.get('/openbadges/v3/achievements/:badgeId', async (c) => {
    const ctx = await publicContext();
    const found = ctx && (await sharedBadge(c.req.param('badgeId')));
    if (!ctx || !found) return missing(c, 'Badge');
    const text = await badgeText(db, found.badge, found.courseTitle, ctx.issuer.name);
    return c.json({ '@context': [VC2_CONTEXT, OB3_CONTEXT], ...ob3Achievement(ctx.urls, found.badge, text, ctx.issuer) });
  });

  /** The share, and whether it is still valid. */
  async function sharedAward(shareId: string) {
    const ctx = await publicContext();
    const state = ctx ? await loadShareState(db, shareId) : null;
    if (!ctx || !state) return null;
    return { ...ctx, state, status: shareStatus(state) };
  }

  async function textFor(state: ShareState, issuerName: string) {
    return badgeText(db, state.badge!, state.courseTitle, issuerName);
  }

  r.get('/openbadges/v2/assertions/:shareId', async (c) => {
    // Browsers get a redirect, everyone else JSON: caches must keep the two apart.
    c.header('Vary', 'Accept');
    const found = await sharedAward(c.req.param('shareId'));
    if (!found) return missing(c, 'Assertion');
    // People following the link in a browser get the verification page; backpacks and verifiers get JSON.
    if (/^\s*text\/html/i.test(c.req.header('accept') ?? '')) return c.redirect(found.urls.page(found.state.share.id), 303);
    if (!found.status.valid) return revoked(c, found.urls, found.state.share.id, found.status.reason);
    return c.json(ob2Assertion(found.urls, found.state));
  });

  r.get('/openbadges/v2/assertions/:shareId/badge.svg', async (c) => {
    const found = await sharedAward(c.req.param('shareId'));
    if (!found) return missing(c, 'Assertion');
    if (!found.status.valid) return revoked(c, found.urls, found.state.share.id, found.status.reason);
    const assertion = ob2Assertion(found.urls, found.state);
    const svg = bakeSvg(badgeSvg(found.state.badge!), { version: 2, verify: assertion.id, assertion });
    return svgResponse(c, svg, `${slugify(found.state.badge!.name, 'badge')}-open-badge-2.svg`);
  });

  r.get('/openbadges/v3/credentials/:shareId', async (c) => {
    const found = await sharedAward(c.req.param('shareId'));
    if (!found) return missing(c, 'Credential');
    if (!found.status.valid) return revoked(c, found.urls, found.state.share.id, found.status.reason);
    const text = await textFor(found.state, found.issuer.name);
    const jwt = await signedCredential(found.urls, await issuerKey(db), found.state, text, found.issuer);
    c.header('Content-Type', 'text/plain; charset=utf-8');
    if (c.req.query('download') !== undefined) {
      c.header('Content-Disposition', `attachment; filename="${slugify(found.state.badge!.name, 'badge')}-open-badge-3.jwt"`);
    }
    return c.body(jwt);
  });

  r.get('/openbadges/v3/credentials/:shareId/badge.svg', async (c) => {
    const found = await sharedAward(c.req.param('shareId'));
    if (!found) return missing(c, 'Credential');
    if (!found.status.valid) return revoked(c, found.urls, found.state.share.id, found.status.reason);
    const text = await textFor(found.state, found.issuer.name);
    const jwt = await signedCredential(found.urls, await issuerKey(db), found.state, text, found.issuer);
    const svg = bakeSvg(badgeSvg(found.state.badge!), { version: 3, verify: jwt });
    return svgResponse(c, svg, `${slugify(found.state.badge!.name, 'badge')}-open-badge-3.svg`);
  });

  r.get('/openbadges/v3/status/1', async (c) => {
    const ctx = await publicContext();
    if (!ctx) return missing(c);
    const jwt = await signedStatusList(db, ctx.urls, await issuerKey(db));
    c.header('Content-Type', 'application/vc+jwt');
    return c.body(jwt);
  });

  r.get('/openbadges/v3/jwks.json', async (c) => {
    const ctx = await publicContext();
    if (!ctx) return missing(c);
    return c.json({ keys: [publicJwk(ctx.urls, await issuerKey(db))] });
  });

  r.get('/openbadges/v3/keys/:keyId', async (c) => {
    const ctx = await publicContext();
    if (!ctx) return missing(c);
    const key = await issuerKey(db);
    if (c.req.param('keyId') !== key.id) return missing(c, 'Key');
    c.header('Content-Type', 'application/jwk+json');
    return c.body(JSON.stringify(publicJwk(ctx.urls, key)));
  });

  // Anything else under /openbadges/ is a JSON 404, not the web app.
  r.all('/openbadges/*', (c) => missing(c));

  // ---- verification page -----------------------------------------------------------------------------

  r.get('/api/open-badges/shares/:shareId', async (c) => {
    const found = await sharedAward(c.req.param('shareId'));
    if (!found) throw notFound('Shared badge');
    const { state, status, urls, issuer } = found;
    const base: SharedBadgeVerification = {
      id: state.share.id,
      status: status.valid ? 'valid' : 'revoked',
      revocationReason: status.reason,
      issuer: { name: issuer.name, url: issuer.url },
      badge: null,
      recipientName: null,
      issuedOn: null,
      note: null,
      links: null,
    };
    // Once it is no longer valid, nothing about the recipient or the award is shown.
    if (!status.valid) return c.json(base);
    const badge = state.badge!;
    const text = await textFor(state, issuer.name);
    return c.json({
      ...base,
      badge: {
        name: badge.name,
        description: text.description,
        icon: badge.icon,
        color: badge.color,
        criteria: text.criteria,
        course: state.courseTitle,
      },
      recipientName: state.user!.name,
      issuedOn: state.award!.awardedAt,
      note: state.award!.note,
      links: { assertion: urls.ob2Assertion(state.share.id), credential: urls.ob3Credential(state.share.id) },
    } satisfies SharedBadgeVerification);
  });

  // ---- the recipient's shares --------------------------------------------------------------------------

  r.get('/api/badges/:badgeId/share', async (c) => {
    const user = requireUser(c);
    return c.json(await shareStatusFor(c.req.param('badgeId'), user.id));
  });

  r.post('/api/badges/:badgeId/share', async (c) => {
    const user = requireUser(c);
    // Sharing publishes the recipient's name: only they can decide that, not someone signed in as them.
    if (c.get('session')?.impersonatorId) throw forbidden('Only the recipient can share their badge. Stop impersonating first.');
    if (!publicBase(deps)) throw conflict(OPEN_BADGES_UNAVAILABLE);
    const badgeId = c.req.param('badgeId');
    if (!BADGE_ID_RE.test(badgeId) || !(await activeAward(db, badgeId, user.id))) {
      throw forbidden('You can only share badges you have earned.');
    }
    await createShare(db, badgeId, user.id);
    return c.json(await shareStatusFor(badgeId, user.id));
  });

  r.delete('/api/badges/:badgeId/share', async (c) => {
    const user = requireUser(c);
    const badgeId = c.req.param('badgeId');
    if (BADGE_ID_RE.test(badgeId)) await withdrawShares(db, badgeId, user.id);
    return c.json(await shareStatusFor(badgeId, user.id));
  });

  r.get('/api/me/badge-shares', async (c) => {
    const user = requireUser(c);
    const base = publicBase(deps);
    if (!base) return c.json([] satisfies MyBadgeShare[]);
    const rows = await db
      .selectFrom('openBadgeShares')
      .innerJoin('badgeAwards', (join) =>
        join
          .onRef('badgeAwards.badgeId', '=', 'openBadgeShares.badgeId')
          .onRef('badgeAwards.userId', '=', 'openBadgeShares.userId')
          .onRef('badgeAwards.awardedAt', '=', 'openBadgeShares.awardedAt'),
      )
      .selectAll('openBadgeShares')
      .where('openBadgeShares.userId', '=', user.id)
      .where('openBadgeShares.withdrawnAt', 'is', null)
      .where('badgeAwards.revokedAt', 'is', null)
      .orderBy('openBadgeShares.createdAt', 'desc')
      .execute();
    const urls = openBadgeUrls(base);
    const seen = new Set<string>();
    const shares: MyBadgeShare[] = [];
    for (const row of rows) {
      if (!row.badgeId || seen.has(row.badgeId)) continue;
      seen.add(row.badgeId);
      shares.push({ badgeId: row.badgeId, share: linksFor(urls, row) });
    }
    return c.json(shares);
  });

  // ---- administration -------------------------------------------------------------------------------

  async function adminInfo(): Promise<OpenBadgesAdminInfo> {
    const base = publicBase(deps);
    const [settings, site, activeShares] = await Promise.all([getIssuerSettings(db), getSiteSettings(db), countActiveShares(db)]);
    return {
      settings,
      defaults: { name: site.name, email: defaultIssuerEmail(deps) },
      publicUrl: base,
      issuerUrl: base ? openBadgeUrls(base).ob2Issuer : null,
      activeShares,
    };
  }

  r.get('/api/admin/open-badges', async (c) => {
    requireAdmin(c);
    return c.json(await adminInfo());
  });

  r.put('/api/admin/open-badges', async (c) => {
    requireAdmin(c);
    const input = await readBody(c, issuerSchema);
    await saveIssuerSettings(db, input);
    return c.json(await adminInfo());
  });

  return r;
}
