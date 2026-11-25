/**
 * Errors of the job endpoints (cards 30.1 and 30.6) never hand the client internal details: an
 * unexpected error gets a generic message, and a provider's error text loses key-shaped tokens and
 * account ids.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { clientSafeDetail, sendError, upstreamFailure } from './context.js';

const reply = (status: number, body: unknown) => ({
  status,
  headers: new Headers(),
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});

describe('job errors', () => {
  it('an unexpected error is answered with a generic message', async () => {
    const app = Fastify({ logger: false });
    app.get('/', (_req, res) =>
      sendError(res, new Error('connect ECONNREFUSED 10.0.3.7:6379 (internal-valkey)')),
    );
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('10.0.3.7');
    expect(res.body).not.toContain('ECONNREFUSED');
    await app.close();
  });

  it("a refused credential never echoes the provider's text", () => {
    const error = upstreamFailure(
      'Creating the batch',
      reply(401, {
        error: {
          message: 'Incorrect API key provided: sk-proj-abc1********************wxyz.',
          type: 'invalid_request_error',
        },
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^Creating the batch failed at the provider \(401\)/);
    expect(error.message).not.toContain('sk-');
    expect(error.message).not.toContain('wxyz');
  });

  it('other provider errors keep a short excerpt without keys or account ids', () => {
    const error = upstreamFailure(
      'Uploading the batch input',
      reply(400, {
        error: {
          message: `Invalid file for organization org-AbCdEf1234567890 (key sk-live-1234abcd): ${'x '.repeat(400)}`,
        },
      }),
    );
    expect(error.message).toContain('Invalid file for organization');
    expect(error.message).not.toContain('org-AbCdEf');
    expect(error.message).not.toContain('sk-live');
    expect(error.message.length).toBeLessThan(320);
    expect(upstreamFailure('Checking the batch', reply(503, 'busy')).status).toBe(502);
    expect(upstreamFailure('Checking the batch', reply(429, 'slow down')).status).toBe(429);
    expect(clientSafeDetail('token ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd here')).toBe(
      'token [redacted] here',
    );
  });
});
