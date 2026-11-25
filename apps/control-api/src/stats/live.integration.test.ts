/**
 * Live view over SSE against real Postgres and Valkey (card 24.4): an event published on the
 * organization's channel reaches an open stream in well under two seconds, other organizations'
 * events never do, and a closed stream releases its subscription.
 */
import { liveChannel, type LiveRequestEvent } from '@dirouter/contracts';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { LiveHub } from './live.hub.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';

const live = (id: string): LiveRequestEvent => ({
  id,
  createdAt: new Date().toISOString(),
  projectId: 'prj',
  apiKeyId: 'vk',
  requestedModel: 'smart',
  modelId: null,
  providerId: 'prv',
  stream: false,
  status: 'success',
  httpStatus: 200,
  errorCode: null,
  inputTokens: 3,
  outputTokens: 4,
  costUsd: '0.0001',
  latencyMs: 20,
  ttftMs: null,
});

/** Reads SSE frames from a fetch body until `until` returns true or the time runs out. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  until: (events: { event: string; data: string }[]) => boolean,
  timeoutMs = 5_000,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: string }[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!until(events) && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => {
          resolve({ done: true, value: undefined });
        }, deadline - Date.now()),
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data !== undefined) events.push({ event, data });
    }
  }
  return { events, reader };
}

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('live view over SSE', () => {
  let app: NestFastifyApplication;
  let base = '';
  let owner = '';
  let org = '';
  const publisher = new Redis(VALKEY_URL ?? '', { lazyConnect: true });

  beforeAll(async () => {
    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: generateKey(),
      KEY_PEPPER: 'p'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
      GATEWAY_INTERNAL_URL: 'http://127.0.0.1:9',
    });
    app = await createApp(env);
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, api_keys, projects, teams, users, organizations, config_versions RESTART IDENTITY CASCADE',
      );
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    owner = (
      (await (
        await fetch(`${base}/api/v1/auth/setup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            organizationName: 'Live Org',
            name: 'O',
            email: 'lv@example.com',
            password: PW,
          }),
        })
      ).json()) as { accessToken: string }
    ).accessToken;
    org =
      (
        (await (
          await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${owner}` } })
        ).json()) as { organizations: { id: string }[] }
      ).organizations[0]?.id ?? '';
    await publisher.connect();
  });

  afterAll(async () => {
    publisher.disconnect();
    await app.close();
  });

  const open = (token = owner) =>
    fetch(`${base}/api/v1/orgs/${org}/stats/live/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });

  it('needs a signed-in member', async () => {
    expect((await open('not-a-token')).status).toBe(401);
  });

  it('delivers a published request in under two seconds, and only its own organization', async () => {
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = res.body;
    if (!body) throw new Error('no body');
    const ready = await readEvents(body, (events) => events.some((e) => e.event === 'ready'));
    ready.reader.releaseLock();
    expect(app.get(LiveHub).size).toBe(1);

    await publisher.publish(liveChannel('org_someone_else'), JSON.stringify(live('req_foreign')));
    const sent = Date.now();
    await publisher.publish(
      liveChannel(org),
      JSON.stringify({ ...live('req_live'), endUser: 'must-not-pass' }),
    );
    const got = await readEvents(body, (events) => events.some((e) => e.event === 'request'));
    const elapsed = Date.now() - sent;
    const requests = got.events.filter((e) => e.event === 'request');
    expect(requests).toHaveLength(1);
    const event = JSON.parse(requests[0]?.data ?? '{}') as Record<string, unknown>;
    expect(event.id).toBe('req_live');
    expect(event).not.toHaveProperty('endUser');
    expect(elapsed).toBeLessThan(2_000);
    await got.reader.cancel();

    // The closed stream gives its subscription back.
    for (let i = 0; i < 50 && app.get(LiveHub).size > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(app.get(LiveHub).size).toBe(0);
  });
});
