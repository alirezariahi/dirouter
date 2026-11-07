import { Writable } from 'node:stream';

import { OpenAIErrorBody, ProblemDetails, AnthropicErrorBody, Ulid } from '@dirouter/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  BudgetExceededError,
  CryptoError,
  DiRouterError,
  EnvValidationError,
  REDACTED,
  RateLimitError,
  UpstreamError,
  ValidationError,
  baseEnvSchema,
  createLogger,
  decrypt,
  encrypt,
  envBoolean,
  envKeyring,
  envPort,
  generateKey,
  costForTokens,
  formatUsd,
  hashApiKey,
  parseUsd,
  percentOf,
  sumUsd,
  keyVersionOf,
  loadEnvOrExit,
  needsReencryption,
  parseEnv,
  parseKeyring,
  prefixedId,
  sha256Hex,
  toDiRouterError,
  ulid,
  ulidTime,
  verifyApiKey,
} from './index.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  // pino در حالت stream به‌صورت همگام می‌نویسد.
  const logger = createLogger({ service: 'test', level: 'debug', destination });
  return { logger, lines };
}

describe('logger', () => {
  it('writes JSON with service, level label and ISO time', () => {
    const { logger, lines } = captureLogger();
    logger.info({ requestId: 'req_1' }, 'hello');
    expect(lines[0]).toMatchObject({
      service: 'test',
      level: 'info',
      msg: 'hello',
      requestId: 'req_1',
    });
    expect(typeof lines[0]?.time).toBe('string');
  });

  it('redacts Authorization headers and key fields at any common depth', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      req: {
        headers: { authorization: 'Bearer sk-live-123', 'x-api-key': 'sk-ant-456', accept: '*/*' },
      },
      apiKey: 'dr-live-secret',
      credential: { secret: 'top-secret', name: 'primary' },
      provider: { auth: { token: 't0k3n' } },
    });
    const line = lines[0] as {
      req: { headers: Record<string, string> };
      apiKey: string;
      credential: { secret: string; name: string };
      provider: { auth: { token: string } };
    };
    expect(line.req.headers.authorization).toBe(REDACTED);
    expect(line.req.headers['x-api-key']).toBe(REDACTED);
    expect(line.req.headers.accept).toBe('*/*');
    expect(line.apiKey).toBe(REDACTED);
    expect(line.credential).toEqual({ secret: REDACTED, name: 'primary' });
    expect(line.provider.auth.token).toBe(REDACTED);
    expect(JSON.stringify(lines)).not.toContain('sk-live-123');
  });
});

describe('errors', () => {
  it('converts to problem+json, OpenAI and Anthropic formats', () => {
    const err = new DiRouterError('model_not_allowed', { param: 'model' });
    expect(err.status).toBe(403);
    expect(ProblemDetails.parse(err.toProblem('req_1'))).toMatchObject({
      code: 'model_not_allowed',
      requestId: 'req_1',
      type: 'https://dirouter.dev/errors/model_not_allowed',
    });
    expect(OpenAIErrorBody.parse(err.toOpenAI()).error).toEqual({
      message: 'Model not allowed for this key',
      type: 'permission_error',
      param: 'model',
      code: 'model_not_allowed',
    });
    expect(AnthropicErrorBody.parse(err.toAnthropic()).error.type).toBe('permission_error');
  });

  it('maps budget errors to billing/quota types', () => {
    const err = new BudgetExceededError();
    expect(err.status).toBe(429);
    expect(err.toOpenAI().error.type).toBe('insufficient_quota');
    expect(err.toAnthropic().error.type).toBe('billing_error');
  });

  it('includes field errors in validation problems', () => {
    const err = new ValidationError([{ path: 'name', message: 'Required' }]);
    expect(err.toProblem().errors).toEqual([{ path: 'name', message: 'Required' }]);
    expect(err.message).toBe('name: Required');
  });

  it('knows which errors are retryable', () => {
    expect(new UpstreamError('upstream_overloaded', { upstreamStatus: 529 }).retryable).toBe(true);
    expect(new UpstreamError('no_available_provider').retryable).toBe(false);
    expect(new UpstreamError('upstream_error', { retryable: false }).retryable).toBe(false);
    expect(new RateLimitError({ retryAfterMs: 1000 }).retryable).toBe(false);
  });

  it('wraps unknown errors as internal_error and keeps the cause', () => {
    const cause = new TypeError('boom');
    const err = toDiRouterError(cause);
    expect(err.code).toBe('internal_error');
    expect(err.cause).toBe(cause);
    const known = new RateLimitError();
    expect(toDiRouterError(known)).toBe(known);
  });
});

describe('env', () => {
  const schema = baseEnvSchema.extend({
    PORT: envPort(8080),
    MASTER_KEY: envKeyring(),
    DATABASE_URL: z.url(),
    DEBUG_SQL: envBoolean(false),
  });

  it('parses and applies defaults', () => {
    const env = parseEnv(schema, {
      MASTER_KEY: generateKey(),
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DEBUG_SQL: 'yes',
    });
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DEBUG_SQL).toBe(true);
    expect(env.MASTER_KEY.currentVersion).toBe(1);
  });

  it('lists every missing or invalid variable in Persian and English', () => {
    let caught: unknown;
    try {
      parseEnv(schema, { PORT: 'abc', MASTER_KEY: 'too-short', LOG_LEVEL: 'loud' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.issues.map((i) => i.variable).sort()).toEqual([
      'DATABASE_URL',
      'LOG_LEVEL',
      'MASTER_KEY',
      'PORT',
    ]);
    expect(err.issues.find((i) => i.variable === 'DATABASE_URL')?.fa).toBe(
      'مقدار الزامی وارد نشده است',
    );
    expect(err.message).toContain('پیکربندی محیط نامعتبر است / Invalid environment configuration');
    expect(err.message).toContain('MASTER_KEY');
  });

  it('exits with code 1 on boot when env is incomplete', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => loadEnvOrExit(schema, {})).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('DATABASE_URL');
    exit.mockRestore();
    stderr.mockRestore();
  });
});

describe('crypto', () => {
  const k1 = generateKey();
  const k2 = generateKey();

  it('round-trips unicode plaintext', () => {
    const ring = parseKeyring(k1);
    const secret = 'sk-proj-کلید-🔑';
    const ct = encrypt(ring, secret);
    expect(ct).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(ct).not.toContain(secret);
    expect(decrypt(ring, ct)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const ring = parseKeyring(k1);
    expect(encrypt(ring, 'same')).not.toBe(encrypt(ring, 'same'));
  });

  it('fails with a wrong key', () => {
    const ct = encrypt(parseKeyring(k1), 'secret');
    expect(() => decrypt(parseKeyring(k2), ct)).toThrow(CryptoError);
  });

  it('fails when the ciphertext is tampered with', () => {
    const ring = parseKeyring(k1);
    const [version, body] = encrypt(ring, 'secret').split('.') as [string, string];
    const bytes = Buffer.from(body, 'base64url');
    bytes[14]! ^= 0x01; // یک بیت از بدنهٔ ciphertext
    expect(() => decrypt(ring, `${version}.${bytes.toString('base64url')}`)).toThrow(
      /wrong key or tampered/,
    );
  });

  it('binds ciphertext to its AAD context', () => {
    const ring = parseKeyring(k1);
    const ct = encrypt(ring, 'secret', 'cred_1');
    expect(decrypt(ring, ct, 'cred_1')).toBe('secret');
    expect(() => decrypt(ring, ct, 'cred_2')).toThrow(CryptoError);
  });

  it('keeps old versions decryptable after rotation', () => {
    const old = parseKeyring(`1:${k1}`);
    const ct = encrypt(old, 'secret');
    const rotated = parseKeyring(`1:${k1},2:${k2}`);
    expect(rotated.currentVersion).toBe(2);
    expect(decrypt(rotated, ct)).toBe('secret');
    expect(needsReencryption(rotated, ct)).toBe(true);
    const fresh = encrypt(rotated, 'secret');
    expect(keyVersionOf(fresh)).toBe(2);
    expect(needsReencryption(rotated, fresh)).toBe(false);
  });

  it('fails when the key version is missing from the keyring', () => {
    const ct = encrypt(parseKeyring(`3:${k1}`), 'secret');
    expect(() => decrypt(parseKeyring(`1:${k1}`), ct)).toThrow(/v3 is not in the keyring/);
  });

  it('rejects malformed keyrings', () => {
    expect(() => parseKeyring('')).toThrow(CryptoError);
    expect(() => parseKeyring('c2hvcnQ=')).toThrow(/32 bytes/);
    expect(() => parseKeyring(`${k1},${k2}`)).toThrow(/version prefix/);
    expect(() => parseKeyring(`1:${k1},1:${k2}`)).toThrow(/duplicate/);
    expect(() => decrypt(parseKeyring(k1), 'not-a-ciphertext')).toThrow(/malformed/);
  });
});

describe('ulid', () => {
  it('generates valid, time-ordered ids', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(Ulid.safeParse(a).success).toBe(true);
    expect(a < b).toBe(true);
    expect(ulidTime(a)).toBe(1_700_000_000_000);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid()));
    expect(ids.size).toBe(10_000);
  });

  it('supports prefixes', () => {
    expect(prefixedId('req')).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('hash', () => {
  it('hashes and verifies API keys with a pepper', () => {
    const hash = hashApiKey('dr-live-abc', 'pepper');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyApiKey('dr-live-abc', 'pepper', hash)).toBe(true);
    expect(verifyApiKey('dr-live-abd', 'pepper', hash)).toBe(false);
    expect(verifyApiKey('dr-live-abc', 'other', hash)).toBe(false);
    expect(verifyApiKey('dr-live-abc', 'pepper', 'zz')).toBe(false);
  });

  it('matches the known HMAC-SHA256 and SHA-256 test vectors', () => {
    // RFC 4231 test case 2
    expect(hashApiKey('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(sha256Hex('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });
});

describe('money', () => {
  it('parses and formats with 8 decimals', () => {
    expect(formatUsd(parseUsd('2.5'))).toBe('2.50000000');
    expect(formatUsd(parseUsd('0.00000001'))).toBe('0.00000001');
    expect(formatUsd(parseUsd('-1.2'))).toBe('-1.20000000');
    expect(() => parseUsd('0.000000001')).toThrow(TypeError);
    expect(() => parseUsd('1e-3')).toThrow(TypeError);
  });

  it('prices tokens exactly (no float drift)', () => {
    // GPT-4.1: $2/MTok input, $8/MTok output
    const cost = sumUsd([costForTokens(1200, '2'), costForTokens(300, '8')]);
    expect(formatUsd(cost)).toBe('0.00480000');
    // 0.1 + 0.2 class of error does not exist
    expect(formatUsd(sumUsd([parseUsd('0.1'), parseUsd('0.2')]))).toBe('0.30000000');
    // one token at $0.10/MTok = $0.0000001
    expect(formatUsd(costForTokens(1, '0.10'))).toBe('0.00000010');
    // half-up rounding below 1e-8
    expect(formatUsd(costForTokens(1, '0.015'))).toBe('0.00000002');
  });

  it('computes threshold percentages', () => {
    expect(percentOf(parseUsd('40'), parseUsd('50'))).toBe(80);
    expect(percentOf(parseUsd('1'), 0n)).toBe(100);
  });
});
