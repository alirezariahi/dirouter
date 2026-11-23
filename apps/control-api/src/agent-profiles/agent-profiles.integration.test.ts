/** Agent profiles: CRUD, preview with a placeholder and one-click setup (card 20.5). */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const MASTER_KEY = generateKey();

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('agent profiles over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  let profileId = '';

  const call = (method: string, url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/orgs/${org}/${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

  beforeAll(async () => {
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY,
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
        PUBLIC_GATEWAY_URL: 'https://api.example.com',
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, agent_profiles, organizations CASCADE',
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'Agents',
            name: 'O',
            email: 'agents@example.com',
            password: 'a-long-enough-password',
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: { authorization: `Bearer ${token}` },
          })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates, lists and updates profiles; names are unique per organization', async () => {
    const created = await call('POST', 'agent-profiles', {
      name: 'Team Claude',
      tool: 'claude-code',
      mainModel: 'anthropic/claude-sonnet',
      fastModel: 'anthropic/claude-haiku',
      options: { disableNonessentialTraffic: true },
    });
    expect(created.statusCode).toBe(201);
    profileId = created.json<{ id: string }>().id;
    expect(
      (await call('POST', 'agent-profiles', { name: 'Team Claude', tool: 'codex', mainModel: 'm' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('POST', 'agent-profiles', { name: 'X', tool: 'vim', mainModel: 'm' })).statusCode,
    ).toBe(422);
    const fastDefault = await call('POST', 'agent-profiles', {
      name: 'Codex',
      tool: 'codex',
      mainModel: 'openai/gpt',
    });
    expect(fastDefault.json()).toMatchObject({ fastModel: 'openai/gpt' });
    const list = (await call('GET', 'agent-profiles')).json<{ name: string }[]>();
    expect(list.map((p) => p.name)).toEqual(['Codex', 'Team Claude']);
    const patched = await call('PATCH', `agent-profiles/${profileId}`, { name: 'Team Claude 2' });
    expect(patched.json()).toMatchObject({ name: 'Team Claude 2', tool: 'claude-code' });
  });

  it('previews with a placeholder, never a key', async () => {
    const res = await call('GET', `agent-profiles/${profileId}/preview`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ files: { name: string; content: string }[]; script: string }>();
    expect(body.files.map((f) => f.name)).toEqual([
      'claude-code.env',
      'claude-code.json',
      'claude-dirouter',
    ]);
    expect(body.files[0]?.content).toContain("ANTHROPIC_BASE_URL='https://api.example.com'");
    expect(body.files[0]?.content).toContain('<YOUR_DIROUTER_KEY>');
    expect(body.files[0]?.content).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'");
    expect(body.script).toContain('$HOME/.config/dirouter/team-claude-2');
  });

  it("setup creates a key limited to the profile's models and embeds it once", async () => {
    const project = (await call('POST', 'projects', { name: 'P' })).json<{ id: string }>().id;
    const res = await call('POST', `agent-profiles/${profileId}/setup`, { projectId: project });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ keyId: string; key: string; script: string }>();
    expect(body.script).toContain(`ANTHROPIC_AUTH_TOKEN='${body.key}'`);
    const key = await app
      .get(PrismaService)
      .client.apiKey.findUniqueOrThrow({ where: { id: body.keyId } });
    expect(key.allowedModels.sort()).toEqual(['anthropic/claude-haiku', 'anthropic/claude-sonnet']);
    expect(key.projectId).toBe(project);
    // The key is not stored with the profile and preview stays keyless.
    expect((await call('GET', `agent-profiles/${profileId}/preview`)).body).not.toContain(body.key);
  });

  it('deletes, and other ids are not found', async () => {
    expect((await call('DELETE', `agent-profiles/${profileId}`)).statusCode).toBe(204);
    expect((await call('GET', `agent-profiles/${profileId}/preview`)).statusCode).toBe(404);
    expect((await call('PATCH', 'agent-profiles/apf_missing', { name: 'x' })).statusCode).toBe(404);
  });
});
