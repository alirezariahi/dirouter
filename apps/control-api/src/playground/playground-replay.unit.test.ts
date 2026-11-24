/**
 * Replay through the playground (card 24.1): a conversation stored in the Log Explorer is sent
 * again, system text and earlier turns included, to whichever models the user picks.
 */
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../env.js';
import type { PrismaService } from '../infra/prisma.service.js';
import { PlaygroundService } from './playground.service.js';

describe('playground replay', () => {
  const seen: { model: string; messages: unknown[] }[] = [];
  let gateway: Server;
  let service: PlaygroundService;

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { model: string; messages: unknown[] };
        seen.push(body);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [{ message: { content: `answer from ${body.model}` } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          }),
        );
      });
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const address = gateway.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const prisma = {
      client: {
        apiKey: {
          findUnique: () =>
            Promise.resolve({
              id: 'key_1',
              organizationId: 'org_1',
              createdById: 'usr_1',
              status: 'ACTIVE',
              expiresAt: null,
              revokedAt: null,
            }),
        },
        model: { findMany: () => Promise.resolve([]) },
      },
    } as unknown as PrismaService;
    service = new PlaygroundService(prisma, {
      KEY_PEPPER: 'p'.repeat(32),
      GATEWAY_INTERNAL_URL: `http://127.0.0.1:${String(port)}`,
    } as Env);
  });

  afterAll(() => {
    gateway.close();
  });

  it('sends the stored conversation to every chosen model', async () => {
    const result = await service.compare(
      { organizationId: 'org_1', userId: 'usr_1', role: 'OWNER' },
      {
        apiKey: 'dr-replay-key-0000000000',
        models: ['model-a', 'model-b'],
        system: 'be brief',
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
        ],
        prompt: 'second',
        maxTokens: 64,
      },
    );
    expect(result.results.map((r) => [r.model, r.ok, r.text])).toEqual([
      ['model-a', true, 'answer from model-a'],
      ['model-b', true, 'answer from model-b'],
    ]);
    expect(seen.map((s) => s.model).sort()).toEqual(['model-a', 'model-b']);
    for (const call of seen)
      expect(call.messages).toEqual([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ]);
  });
});
