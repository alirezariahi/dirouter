/**
 * Streamed playground over HTTP (card 25.6). mock-provider stands in for the gateway: it speaks the
 * same OpenAI streaming API, so the events, TTFT, tool calls and the image request can be checked
 * end to end through control-api.
 */
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type Event = { event: string; data: Record<string, unknown> };
const parse = (body: string): Event[] =>
  body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (\S+)/m.exec(frame)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('streamed playground over HTTP', () => {
  const mock = buildMock();
  let mockRoot = '';
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  let key = '';
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
  const mockSays = (directives: string) =>
    fetch(`${mockRoot}/__mock/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directives }),
    });

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
        GATEWAY_INTERNAL_URL: mockRoot,
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, organizations CASCADE',
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
            organizationName: 'Play',
            name: 'O',
            email: 'play@example.com',
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
    const project = (await call('POST', 'projects', { name: 'Playground' })).json<{ id: string }>()
      .id;
    key = (await call('POST', 'keys', { name: 'play', projectId: project })).json<{ key: string }>()
      .key;
  });

  afterAll(async () => {
    await app.close();
    await mock.close();
  });

  it('streams the answer as events with routing headers, TTFT and usage', async () => {
    await mockSays('text=hello from the stream,chunks=4');
    const res = await call('POST', 'playground/stream', {
      apiKey: key,
      model: 'mock/small',
      prompt: 'hi',
      maxTokens: 64,
      topP: 0.5,
      reasoningEffort: 'low',
      responseFormat: { type: 'text' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parse(res.body);
    expect(events[0]?.event).toBe('meta');
    expect(events[0]?.data.status).toBe(200);
    expect(events.some((e) => e.event === 'ttft')).toBe(true);
    const text = events
      .filter((e) => e.event === 'chunk')
      .map(
        (e) =>
          (e.data.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content ??
          '',
      )
      .join('');
    expect(text).toBe('hello from the stream');
    const end = events.at(-1);
    expect(end?.event).toBe('end');
    expect(typeof end?.data.ttftMs).toBe('number');
    // The parameters reached the upstream as a client sends them.
    const stats = (await (await fetch(`${mockRoot}/__mock/stats`)).json()) as {
      last: Record<string, unknown>[];
    };
    expect(stats.last.at(-1)).toMatchObject({
      stream: true,
      max_tokens: 64,
      top_p: 0.5,
      reasoning_effort: 'low',
      response_format: { type: 'text' },
    });
  });

  it('runs a request with a tool and one with an image', async () => {
    await mockSays('tool');
    const tools = await call('POST', 'playground/stream', {
      apiKey: key,
      model: 'mock/tool',
      prompt: 'weather in Tehran?',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
      toolChoice: 'auto',
    });
    const toolDeltas = parse(tools.body)
      .filter((e) => e.event === 'chunk')
      .flatMap(
        (e) =>
          (
            e.data.choices as {
              delta?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
            }[]
          )[0]?.delta?.tool_calls ?? [],
      );
    expect(toolDeltas[0]?.function?.name).toBe('get_weather');
    expect(toolDeltas.map((d) => d.function?.arguments ?? '').join('')).toBe('{"city":"Tehran"}');

    await mockSays('text=a small red square');
    const image = await call('POST', 'playground/stream', {
      apiKey: key,
      model: 'mock/small',
      prompt: 'what is in the picture?',
      image: PNG,
    });
    expect(parse(image.body).at(-1)?.event).toBe('end');
    const stats = (await (await fetch(`${mockRoot}/__mock/stats`)).json()) as {
      last: { messages: { content: unknown }[] }[];
    };
    expect(stats.last.at(-1)?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'what is in the picture?' },
      { type: 'image_url', image_url: { url: PNG } },
    ]);
  });

  it('refuses a key that is not the caller’s before streaming anything', async () => {
    const res = await call('POST', 'playground/stream', {
      apiKey: 'dr-unknown-0000000000000000',
      model: 'mock/small',
      prompt: 'hi',
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('json');
  });
});
