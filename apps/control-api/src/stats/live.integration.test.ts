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
import { hashPassword } from '../auth/crypto.js';
import { liveTimings } from './live.controller.js';
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
    // Re-check open streams every 200 ms instead of every 30 s.
    liveTimings.recheckMs = 200;
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

  /** A member signed in with a password; returns their id and access token. */
  async function member(email: string) {
    const db = app.get(PrismaService).client;
    const user = await db.user.create({
      data: {
        id: `usr_${email.split('@')[0] ?? ''}`,
        email,
        name: email,
        passwordHash: await hashPassword(PW),
      },
    });
    await db.membership.create({
      data: { id: `mem_${user.id}`, userId: user.id, organizationId: org, role: 'VIEWER' },
    });
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PW }),
    });
    return { id: user.id, token: ((await login.json()) as { accessToken: string }).accessToken };
  }

  /** Opens a stream and waits for `ready`. */
  async function ready(token: string) {
    const res = await open(token);
    expect(res.status).toBe(200);
    const body = res.body;
    if (!body) throw new Error('no body');
    const got = await readEvents(body, (events) => events.some((e) => e.event === 'ready'));
    got.reader.releaseLock();
    return body;
  }

  const drained = async () => {
    for (let i = 0; i < 100 && app.get(LiveHub).size > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    return app.get(LiveHub).size;
  };

  it('closes a stream once its session is signed out or its membership is gone', async () => {
    const db = app.get(PrismaService).client;
    const signedOut = await member('gone-session@example.com');
    const removed = await member('gone-member@example.com');
    const first = await ready(signedOut.token);
    const second = await ready(removed.token);
    expect(app.get(LiveHub).size).toBe(2);

    await db.refreshToken.updateMany({
      where: { userId: signedOut.id },
      data: { revokedAt: new Date() },
    });
    await db.membership.delete({
      where: { userId_organizationId: { userId: removed.id, organizationId: org } },
    });
    for (const body of [first, second]) {
      const got = await readEvents(
        body,
        (events) => events.some((e) => e.event === 'revoked'),
        3_000,
      );
      expect(got.events.map((e) => e.event)).toContain('revoked');
      await got.reader.cancel();
    }
    expect(await drained()).toBe(0);
  });

  it('caps the open streams of one user', async () => {
    const bodies = [];
    for (let i = 0; i < 5; i++) bodies.push(await ready(owner));
    const sixth = await open();
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    await sixth.body?.cancel();
    // Somebody else is not affected by the owner's streams.
    const other = await member('other-viewer@example.com');
    bodies.push(await ready(other.token));
    for (const body of bodies) await body.cancel();
    expect(await drained()).toBe(0);
    // Closed streams count no more.
    const again = await ready(owner);
    await again.cancel();
    expect(await drained()).toBe(0);
  });
});
