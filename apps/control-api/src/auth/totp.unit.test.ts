/** TOTP (RFC 6238) and single-use recovery codes (card 14.1). */
import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  consumeBackupCode,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  isFreshTotpStep,
  matchTotpStep,
  MemoryTotpStepStore,
  otpauthUrl,
  totpCode,
  totpStepAt,
  ValkeyTotpStepStore,
  verifyTotp,
} from './totp.js';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" (SHA-1).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors (last six digits)', () => {
    expect(totpCode(RFC_SECRET, 59_000)).toBe('287082');
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totpCode(RFC_SECRET, 1_234_567_890_000)).toBe('005924');
    expect(totpCode(RFC_SECRET, 2_000_000_000_000)).toBe('279037');
  });

  it('round-trips base32', () => {
    const secret = generateTotpSecret();
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepts the adjacent time step and rejects anything further away', () => {
    const at = 1_700_000_000_000;
    const code = totpCode(RFC_SECRET, at);
    expect(verifyTotp(RFC_SECRET, code, at)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, at + 30_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, at - 30_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, at + 90_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, at)).toBe(true);
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345', 0)).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef', 0)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '1234567', 0)).toBe(false);
  });

  it('builds an otpauth URL authenticator apps accept', () => {
    const url = new URL(otpauthUrl({ secret: RFC_SECRET, email: 'a@example.com' }));
    expect(url.protocol).toBe('otpauth:');
    expect(decodeURIComponent(url.pathname)).toContain('DiRouter:a@example.com');
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(url.searchParams.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('generates distinct codes and stores only hashes', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
      expect(hashBackupCode(code)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashBackupCode(code)).not.toContain(code);
    }
  });

  it('a code works exactly once', () => {
    const codes = generateBackupCodes(3);
    const stored = codes.map(hashBackupCode);
    const first = codes[0] ?? '';
    const afterFirst = consumeBackupCode(stored, first);
    expect(afterFirst).toHaveLength(2);
    expect(consumeBackupCode(afterFirst ?? [], first)).toBeUndefined();
    // The other codes are still valid.
    expect(consumeBackupCode(afterFirst ?? [], codes[1] ?? '')).toHaveLength(1);
  });

  it('ignores case and separators but rejects unknown codes', () => {
    const [code = ''] = generateBackupCodes(1);
    const stored = [hashBackupCode(code)];
    expect(consumeBackupCode(stored, code.toLowerCase().replace('-', ' '))).toEqual([]);
    expect(consumeBackupCode(stored, 'AAAAA-BBBBB')).toBeUndefined();
  });
});

describe('TOTP replay protection', () => {
  const at = 1_700_000_000_000;

  it('reports which time step a code belongs to', () => {
    const step = totpStepAt(at);
    expect(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, at), at)).toBe(step);
    expect(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, at - 30_000), at)).toBe(step - 1);
    expect(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, at + 30_000), at)).toBe(step + 1);
    expect(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, at + 90_000), at)).toBeUndefined();
    expect(matchTotpStep(RFC_SECRET, 'abcdef', at)).toBeUndefined();
  });

  it('accepts only steps newer than the last accepted one', () => {
    expect(isFreshTotpStep(undefined, 10)).toBe(true);
    expect(isFreshTotpStep(9, 10)).toBe(true);
    expect(isFreshTotpStep(10, 10)).toBe(false);
    expect(isFreshTotpStep(11, 10)).toBe(false);
  });

  it('rejects the same code twice and an older code after a newer one', async () => {
    const store = new MemoryTotpStepStore();
    const step = totpStepAt(at);
    expect(await store.claim('usr_1', step)).toBe(true);
    expect(await store.claim('usr_1', step)).toBe(false);
    expect(await store.claim('usr_1', step - 1)).toBe(false);
    expect(await store.claim('usr_1', step + 1)).toBe(true);
    // Another user is unaffected.
    expect(await store.claim('usr_2', step)).toBe(true);
  });

  it('follows the shared store and keeps rejecting replays when it is unreachable', async () => {
    const calls: (string | number)[][] = [];
    let answer: number | Error = 1;
    const store = new ValkeyTotpStepStore({
      eval: (_script, _numKeys, ...args) => {
        calls.push(args);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    });
    expect(await store.claim('usr_1', 100)).toBe(true);
    expect(calls[0]?.slice(0, 2)).toEqual(['dirouter:mfa:step:usr_1', 100]);
    // Another replica already accepted step 101: the shared store says no.
    answer = 0;
    expect(await store.claim('usr_1', 101)).toBe(false);
    answer = new Error('Connection is closed.');
    expect(await store.claim('usr_1', 102)).toBe(true);
    expect(await store.claim('usr_1', 102)).toBe(false);
  });
});
