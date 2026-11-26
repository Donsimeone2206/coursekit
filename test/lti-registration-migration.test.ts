import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { createDatabase, migrateToLatest, migrations } from '../src/server/db/index.js';
import * as ltiRegistration from '../src/server/db/migrations/014_lti_registration.js';
import { createCoursekit } from '../src/server/index.js';
import { hashPassword } from '../src/server/lib/password.js';
import { login, PASSWORD } from './helpers.js';
import { AGS, ISS, NRPS_SCOPE } from './lti-helpers.js';
import { postRegistration, registrationRequest, startRegistration } from './lti-registration-helpers.js';

const ALL_AGS = [`${AGS}lineitem`, `${AGS}lineitem.readonly`, `${AGS}result.readonly`, `${AGS}score`];

it('upgrades a 0.3.0 database: tools added before keep every scope of their services', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coursekit-lti-reg-upgrade-'));
  const file = join(dir, 'old.db');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'old-key', alg: 'RS256' };

  // A site created by 0.3.0: the migrations up to and including 011_open_badges have run.
  const { db } = await createDatabase(`sqlite://${file}`);
  try {
    const names = Object.keys(migrations).filter((name) => name <= '011_open_badges');
    expect(names).toContain('011_open_badges');
    const v030 = new Migrator({
      db: db.withoutPlugins(),
      provider: { getMigrations: async () => Object.fromEntries(names.map((n) => [n, migrations[n]!])) },
    });
    expect((await v030.migrateToLatest()).error).toBeUndefined();

    // Raw SQL with the 0.3.0 column names, so the test doesn't depend on the new table types.
    const raw = db.withoutPlugins();
    const ts = new Date().toISOString();
    await raw
      .insertInto('users' as never)
      .values({
        id: 'u1',
        email: 'admin@old.test',
        name: 'Old admin',
        password_hash: await hashPassword(PASSWORD),
        role: 'admin',
        status: 'active',
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
    await raw
      .insertInto('lti_tools' as never)
      .values({
        id: 't1',
        name: 'Old tool',
        description: '',
        tool_url: 'https://tool.test/launch',
        login_url: 'https://tool.test/login',
        redirect_uris: JSON.stringify(['https://tool.test/callback']),
        jwks_url: null,
        public_key: JSON.stringify(jwk),
        deep_linking_url: null,
        custom_params: '{}',
        share_name: 1,
        share_email: 0,
        allow_ags: 1,
        allow_nrps: 1,
        client_id: 'oldclientid000000000',
        deployment_id: 'olddeploy001',
        status: 'active',
        created_by: 'u1',
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
  } finally {
    await db.destroy();
  }

  // 0.4.0 starts on it and migrates.
  const lms = await createCoursekit({ databaseUrl: `sqlite://${file}`, dataDir: dir, webDir: false, publicUrl: ISS });
  try {
    const tool = await lms.db.selectFrom('ltiTools').selectAll().where('id', '=', 't1').executeTakeFirstOrThrow();
    expect(tool).toMatchObject({ name: 'Old tool', status: 'active', scopes: null, domains: null, allowAgs: 1, allowNrps: 1 });
    expect(await lms.db.selectFrom('ltiRegistrations').selectAll().execute()).toEqual([]);

    // The tool still gets every scope of the services it was allowed.
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'old-key' })
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience(`${ISS}/lti/token`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('upgrade-1')
      .sign(privateKey);
    const res = await lms.app.request('/lti/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        scope: [...ALL_AGS, NRPS_SCOPE].join(' '),
      }).toString(),
    });
    const body = (await res.json()) as { scope: string };
    expect(res.status).toBe(200);
    expect(body.scope.split(' ').sort()).toEqual([...ALL_AGS, NRPS_SCOPE].sort());

    // Dynamic Registration works on the upgraded site, and the old tool is not marked as registered automatically.
    const admin = await login(lms, 'admin@old.test');
    const started = await startRegistration(admin);
    expect((await postRegistration(lms, started.token, registrationRequest())).status).toBe(201);
    const registered = (await admin.get('/api/admin/lti/registrations')).body as Array<{ toolId: string }>;
    expect(registered.map((r) => r.toolId)).not.toContain('t1');
    expect(await migrateToLatest(lms.db)).toEqual([]);

    // The migration can be undone and applied again.
    const plain = lms.db.withoutPlugins();
    await ltiRegistration.down(plain);
    const columns = await sql<{ name: string }>`select name from pragma_table_info('lti_tools')`.execute(plain);
    expect(columns.rows.map((c) => c.name)).not.toContain('scopes');
    expect(columns.rows.map((c) => c.name)).not.toContain('domains');
    const tables = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(plain);
    expect(tables.rows.map((t) => t.name)).not.toContain('lti_registrations');
    await ltiRegistration.up(plain);
    expect(await lms.db.selectFrom('ltiTools').select(['scopes', 'domains']).where('id', '=', 't1').executeTakeFirstOrThrow()).toEqual({
      scopes: null,
      domains: null,
    });
  } finally {
    await lms.close();
  }
});
