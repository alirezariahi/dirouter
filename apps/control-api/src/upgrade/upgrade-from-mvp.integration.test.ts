/**
 * Upgrade from the MVP (end of sprint 1) to the current release without data loss (card 22.7).
 *
 * A fresh database gets exactly the MVP's migrations (taken from git history) and data written in
 * the MVP's schema: two organizations, an owner, a project, a provider with an encrypted
 * credential, a model and a virtual key. Then every current migration runs, and today's
 * control-api starts on that database: the owner signs in with the old password, everything is
 * still there, the credential still decrypts and the gateway snapshot is built from it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { decrypt, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

/** Last commit of sprint 1, the MVP release. */
const MVP_COMMIT = '1207b66';

const ADMIN_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const ROOT = resolve(import.meta.dirname, '../../../..');
const PRISMA = join(ROOT, 'packages/db/node_modules/.bin/prisma');
const MASTER_KEY = generateKey();
const PEPPER = 'q'.repeat(32);
const RAW_KEY = 'dr-mvp-0000000000000000000001';
const SECRET = 'sk-mvp-provider-secret-1234';
const PASSWORD = 'an-mvp-era-password';

const sql = (url: string, statement: string) =>
  execFileSync(PRISMA, ['db', 'execute', '--url', url, '--stdin'], {
    input: statement,
    cwd: join(ROOT, 'packages/db'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const deploy = (url: string, schema: string) =>
  execFileSync(PRISMA, ['migrate', 'deploy', '--schema', schema], {
    cwd: join(ROOT, 'packages/db'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

describe.skipIf(!ADMIN_URL || !VALKEY_URL)('upgrade from the MVP', () => {
  const name = `dirouter_upgrade_${String(Date.now())}`;
  const url = (ADMIN_URL ?? '').replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  let app: NestFastifyApplication;
  let mvpMigrations = 0;
  let currentOutput = '';

  beforeAll(async () => {
    sql(ADMIN_URL ?? '', `CREATE DATABASE "${name}"`);

    // The MVP's schema, exactly as released.
    const old = mkdtempSync(join(tmpdir(), 'dirouter-mvp-'));
    execFileSync('sh', [
      '-c',
      `git -C "${ROOT}" archive ${MVP_COMMIT} packages/db/prisma | tar -x -C "${old}"`,
    ]);
    const mvpOut = deploy(url, join(old, 'packages/db/prisma/schema.prisma'));
    mvpMigrations = Number(/(\d+) migrations? found/.exec(mvpOut)?.[1] ?? 0);

    // Data as the MVP wrote it.
    const keyring = parseKeyring(MASTER_KEY);
    const secretEnc = encrypt(keyring, SECRET, 'cred_mvp');
    const passwordHash = await hashPassword(PASSWORD);
    sql(
      url,
      `
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES
        ('org_mvp', 'MVP Org', 'mvp-org', '2026-11-08T10:00:00Z', now()),
        ('org_mvp_b', 'Second Org', 'second-org', '2026-11-09T10:00:00Z', now());
      INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES
        ('usr_mvp', 'owner@mvp.example.com', 'MVP Owner', '${passwordHash}', now(), now());
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES
        ('mem_mvp', 'usr_mvp', 'org_mvp', 'OWNER');
      INSERT INTO projects (id, organization_id, name, slug, created_at, updated_at) VALUES
        ('prj_mvp', 'org_mvp', 'Production', 'production', now(), now());
      INSERT INTO providers (id, organization_id, slug, name, type, base_url, created_at, updated_at) VALUES
        ('prv_mvp', 'org_mvp', 'openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', now(), now());
      INSERT INTO credentials (id, provider_id, name, secret_enc, key_version, last4, created_at, updated_at) VALUES
        ('cred_mvp', 'prv_mvp', 'main', '${secretEnc}', 1, '${SECRET.slice(-4)}', now(), now());
      INSERT INTO models (id, organization_id, provider_id, slug, upstream_model, input_price, output_price, created_at, updated_at) VALUES
        ('mdl_mvp', 'org_mvp', 'prv_mvp', 'openai/gpt-4.1', 'gpt-4.1', 2, 8, now(), now());
      INSERT INTO api_keys (id, organization_id, project_id, name, prefix, hash, allowed_models, created_by_id, created_at, updated_at) VALUES
        ('key_mvp', 'org_mvp', 'prj_mvp', 'production key', '${RAW_KEY.slice(0, 10)}', '${hashApiKey(RAW_KEY, PEPPER)}', '{openai/gpt-4.1}', 'usr_mvp', now(), now());
      `,
    );

    // Every migration since.
    currentOutput = deploy(url, join(ROOT, 'packages/db/prisma/schema.prisma'));

    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        VALKEY_URL,
        MASTER_KEY,
        KEY_PEPPER: PEPPER,
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    sql(ADMIN_URL ?? '', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });

  const http = () => app.getHttpAdapter().getInstance();

  it('applies the MVP migrations, then every later one', () => {
    expect(mvpMigrations).toBeGreaterThan(0);
    expect(currentOutput).toMatch(/applied|migrations have been successfully applied/i);
  });

  it('the MVP owner signs in with the old password and finds every record', async () => {
    const login = await http().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@mvp.example.com', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json<{ accessToken: string }>().accessToken;
    const get = async (path: string) =>
      (
        await http().inject({
          method: 'GET',
          url: `/api/v1/orgs/org_mvp/${path}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json<Record<string, unknown>[]>();
    expect(await get('providers')).toEqual([
      expect.objectContaining({
        id: 'prv_mvp',
        type: 'openai',
        credentials: [expect.objectContaining({ id: 'cred_mvp' })],
      }),
    ]);
    expect(await get('models')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'mdl_mvp', slug: 'openai/gpt-4.1' })]),
    );
    expect(await get('keys')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'key_mvp', state: 'active' })]),
    );
  });

  it('the stored credential still decrypts and the key still matches', async () => {
    const db = app.get(PrismaService).client;
    const credential = await db.credential.findUniqueOrThrow({ where: { id: 'cred_mvp' } });
    expect(decrypt(parseKeyring(MASTER_KEY), credential.secretEnc, 'cred_mvp')).toBe(SECRET);
    const key = await db.apiKey.findUniqueOrThrow({ where: { id: 'key_mvp' } });
    expect(key.hash).toBe(hashApiKey(RAW_KEY, PEPPER));
    expect(key.allowedModels).toEqual(['openai/gpt-4.1']);
  });

  it('new features start from sensible values: the oldest organization operates the platform', async () => {
    const db = app.get(PrismaService).client;
    const orgs = await db.organization.findMany({ orderBy: { createdAt: 'asc' } });
    expect(orgs.map((o) => [o.id, o.isPlatform, o.changeApprovalRequired])).toEqual([
      ['org_mvp', true, false],
      ['org_mvp_b', false, false],
    ]);
  });

  it('the gateway snapshot is built from the upgraded data', async () => {
    await app.get(SnapshotService).rebuild('upgrade test');
    const snapshot = (await app.get(SnapshotService).latest())?.snapshot as {
      providers: { id: string; credentials: { id: string; secret: string }[] }[];
      virtualKeys: { id: string; hash: string }[];
      platformOrganizationId?: string;
    };
    expect(snapshot.platformOrganizationId).toBe('org_mvp');
    const provider = snapshot.providers.find((p) => p.id === 'prv_mvp');
    expect(
      decrypt(parseKeyring(MASTER_KEY), provider?.credentials[0]?.secret ?? '', 'cred_mvp'),
    ).toBe(SECRET);
    expect(snapshot.virtualKeys.find((k) => k.id === 'key_mvp')?.hash).toBe(
      hashApiKey(RAW_KEY, PEPPER),
    );
  });
});
