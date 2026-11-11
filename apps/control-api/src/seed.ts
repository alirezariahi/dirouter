/**
 * Development sample data (card 3.11): organization, admin, mock providers, models, combos, aliases,
 * project, and dev keys. Idempotent (fixed IDs and upserts), and runs only in development
 * . At the end it notifies control-api to build a fresh snapshot.
 *
 * Usage: make seed   (in the container: pnpm --filter @dirouter/control-api seed)
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createPrismaClient } from '@dirouter/db';
import { encrypt, hashApiKey, keyVersionOf, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';

import { hashPassword } from './auth/crypto.js';
import { REBUILD_CHANNEL } from './snapshot/channels.js';

const env = process.env;
if ((env.NODE_ENV ?? 'development') !== 'development') {
  process.stderr.write(
    `seed فقط در development اجرا می‌شود / refusing to seed NODE_ENV=${env.NODE_ENV ?? ''}\n`,
  );
  process.exit(1);
}
for (const name of ['DATABASE_URL', 'MASTER_KEY', 'KEY_PEPPER'] as const)
  if (!env[name]) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }

const ORG = 'org_dev';
const MOCK = env.SEED_MOCK_URL ?? 'http://mock-provider:8090';
const ADMIN_EMAIL = 'admin@dirouter.local';
const CREDS_FILE = env.SEED_CREDENTIALS_FILE ?? '/repo/.data/seed-admin.env';
export const DEV_KEYS = {
  main: 'dr-dev-local-0000000000000000',
  limited: 'dr-dev-limited-000000000000',
  expired: 'dr-dev-expired-000000000000',
  ipOnly: 'dr-dev-ipallow-000000000000',
} as const;

const db = createPrismaClient({ databaseUrl: env.DATABASE_URL ?? '' });
const keyring = parseKeyring(env.MASTER_KEY ?? '');
const pepper = env.KEY_PEPPER ?? '';

async function main() {
  await db.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: 'DiRouter Dev', slug: 'dev' },
    update: { name: 'DiRouter Dev', deletedAt: null },
  });

  // Admin: the password is generated and written to a git-ignored file only when the user is new.
  let admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL } });
  let password: string | undefined;
  if (!admin) {
    password = env.SEED_ADMIN_PASSWORD ?? randomBytes(15).toString('base64url');
    admin = await db.user.create({
      data: {
        id: 'usr_dev_admin',
        email: ADMIN_EMAIL,
        name: 'Dev Admin',
        passwordHash: await hashPassword(password),
      },
    });
    await mkdir(dirname(CREDS_FILE), { recursive: true });
    await writeFile(
      CREDS_FILE,
      `SEED_ADMIN_EMAIL=${ADMIN_EMAIL}\nSEED_ADMIN_PASSWORD=${password}\n`,
      { mode: 0o600 },
    );
  }
  await db.membership.upsert({
    where: { userId_organizationId: { userId: admin.id, organizationId: ORG } },
    create: { id: 'mem_dev_admin', userId: admin.id, organizationId: ORG, role: 'OWNER' },
    update: { role: 'OWNER' },
  });

  const providers: {
    id: string;
    type: 'OPENAI_COMPATIBLE' | 'ANTHROPIC' | 'AZURE_OPENAI' | 'GEMINI';
    secret: string;
    options?: object;
    timeouts?: object;
  }[] = [
    { id: 'mock', type: 'OPENAI_COMPATIBLE', secret: 'sk-mock' },
    { id: 'mock-down', type: 'OPENAI_COMPATIBLE', secret: 'mock:status=503' },
    { id: 'mock-bad', type: 'OPENAI_COMPATIBLE', secret: 'mock:status=400' },
    { id: 'mock-429', type: 'OPENAI_COMPATIBLE', secret: 'mock:rate_limit' },
    { id: 'mock-tool', type: 'OPENAI_COMPATIBLE', secret: 'mock:tool' },
    { id: 'mock-nousage', type: 'OPENAI_COMPATIBLE', secret: 'mock:no_usage' },
    { id: 'mock-anthropic', type: 'ANTHROPIC', secret: 'sk-mock' },
    { id: 'mock-gemini', type: 'GEMINI', secret: 'AIza-mock' },
    { id: 'mock-gemini-tool', type: 'GEMINI', secret: 'mock:tool' },
    {
      id: 'mock-azure',
      type: 'AZURE_OPENAI',
      secret: 'sk-mock',
      options: { apiVersion: '2024-10-21' },
    },
    {
      id: 'mock-long',
      type: 'OPENAI_COMPATIBLE',
      secret: `mock:chunks=600,chunk_delay=1000,text=${'x'.repeat(600)}`,
      timeouts: { totalMs: 900_000, idleMs: 30_000 },
    },
  ];
  for (const p of providers) {
    const baseUrl = p.type === 'OPENAI_COMPATIBLE' ? `${MOCK}/v1` : MOCK;
    await db.provider.upsert({
      where: { id: `prv_${p.id}` },
      create: {
        id: `prv_${p.id}`,
        organizationId: ORG,
        slug: p.id,
        name: p.id,
        type: p.type,
        baseUrl,
        options: p.options ?? {},
        ...(p.timeouts ? { timeouts: p.timeouts } : {}),
      },
      update: { baseUrl, enabled: true, deletedAt: null, slug: p.id },
    });
    const credId = `cred_${p.id}`;
    const secretEnc = encrypt(keyring, p.secret, credId);
    await db.credential.upsert({
      where: { id: credId },
      create: {
        id: credId,
        providerId: `prv_${p.id}`,
        name: `${p.id}-key`,
        secretEnc,
        keyVersion: keyVersionOf(secretEnc),
        last4: p.secret.slice(-4),
      },
      update: {
        secretEnc,
        keyVersion: keyVersionOf(secretEnc),
        last4: p.secret.slice(-4),
        status: 'ACTIVE',
      },
    });
  }

  const models: [slug: string, provider: string, upstream: string][] = [
    ['mock/small', 'mock', 'mock-small'],
    ['mock/down', 'mock-down', 'mock-small'],
    ['mock/bad', 'mock-bad', 'mock-small'],
    ['mock/429', 'mock-429', 'mock-small'],
    ['mock/tool', 'mock-tool', 'mock-small'],
    ['mock/nousage', 'mock-nousage', 'mock-small'],
    ['mock/claude', 'mock-anthropic', 'claude-mock'],
    ['mock/gemini', 'mock-gemini', 'gemini-2.5-flash'],
    ['mock/gemini-tool', 'mock-gemini-tool', 'gemini-2.5-flash'],
    ['mock/azure', 'mock-azure', 'gpt-mock-deployment'],
    ['mock/long', 'mock-long', 'mock-small'],
  ];
  const modelId = (slug: string) => `mdl_dev_${slug.replace(/\W+/g, '_')}`;
  for (const [slug, provider, upstream] of models) {
    await db.model.upsert({
      where: { id: modelId(slug) },
      create: {
        id: modelId(slug),
        organizationId: ORG,
        providerId: `prv_${provider}`,
        slug,
        upstreamModel: upstream,
        contextWindow: 200_000,
        inputPrice: '0.10',
        outputPrice: '0.20',
        capabilities: { tools: true, streaming: true },
      },
      update: { enabled: true, deletedAt: null, slug },
    });
  }

  const combos: [slug: string, targets: string[]][] = [
    ['dev', ['mock/down', 'mock/small']],
    ['dev-bad', ['mock/bad', 'mock/small']],
    ['dev-429', ['mock/429', 'mock/claude']],
  ];
  for (const [slug, targets] of combos) {
    const id = `cmb_${slug.replace(/\W+/g, '_')}`;
    await db.combo.upsert({
      where: { id },
      create: { id, organizationId: ORG, slug },
      update: { deletedAt: null, slug },
    });
    await db.comboTarget.deleteMany({ where: { comboId: id } });
    await db.comboTarget.createMany({
      data: targets.map((t, order) => ({
        id: `ct_${id}_${String(order)}`,
        comboId: id,
        modelId: modelId(t),
        order,
      })),
    });
  }

  const aliases: [slug: string, target: { modelId?: string; comboId?: string }][] = [
    ['gpt-4.1', { comboId: 'cmb_dev' }],
    // Claude Code only accepts real Claude model names (card 4.9).
    ['claude-sonnet-4-5', { modelId: modelId('mock/claude') }],
    ['claude-haiku-4-5', { modelId: modelId('mock/tool') }],
  ];
  for (const [slug, target] of aliases) {
    const id = `als_dev_${slug.replace(/\W+/g, '_')}`;
    await db.modelAlias.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG,
        slug,
        modelId: target.modelId ?? null,
        comboId: target.comboId ?? null,
      },
      update: { modelId: target.modelId ?? null, comboId: target.comboId ?? null },
    });
  }

  await db.project.upsert({
    where: { id: 'prj_dev' },
    create: { id: 'prj_dev', organizationId: ORG, name: 'Dev', slug: 'dev' },
    update: { deletedAt: null },
  });
  const keys: [name: keyof typeof DEV_KEYS, extra: object][] = [
    ['main', {}],
    ['limited', { allowedModels: ['mock/small'] }],
    ['expired', { expiresAt: new Date('2020-01-01T00:00:00Z') }],
    ['ipOnly', { ipAllowlist: ['203.0.113.7/32'] }],
  ];
  for (const [name, extra] of keys) {
    const raw = DEV_KEYS[name];
    const id = `key_dev_${name}`;
    await db.apiKey.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG,
        projectId: 'prj_dev',
        name: `dev ${name}`,
        prefix: raw.slice(0, 12),
        hash: hashApiKey(raw, pepper),
        createdById: admin.id,
        ...extra,
      },
      update: {
        hash: hashApiKey(raw, pepper),
        status: 'ACTIVE',
        revokedAt: null,
        rotatedToId: null,
        ...extra,
      },
    });
  }

  // Fresh snapshot immediately (otherwise control-api's periodic build picks it up within 30 seconds).
  if (env.VALKEY_URL) {
    const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 1 });
    await redis.publish(REBUILD_CHANNEL, 'seed').catch(() => undefined);
    redis.disconnect();
  }

  process.stdout.write(
    [
      'seed done / داده‌های نمونه آماده است',
      `  organization: DiRouter Dev (${ORG})`,
      `  admin: ${ADMIN_EMAIL}${password ? ` (password in ${CREDS_FILE})` : ' (existing user, password unchanged)'}`,
      `  dev key: ${DEV_KEYS.main}`,
      `  try: curl http://api.localhost/v1/chat/completions -H 'authorization: Bearer ${DEV_KEYS.main}' \\`,
      `       -H 'content-type: application/json' -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}'`,
      '',
    ].join('\n'),
  );
}

try {
  await main();
} finally {
  await db.$disconnect();
}
