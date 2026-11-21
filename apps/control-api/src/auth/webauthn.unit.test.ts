/** WebAuthn assertion checks (card 14.1): user flags, signature counter and challenge lookup. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertUserFlags,
  clientDataChallenge,
  counterRegressed,
  FLAG_USER_PRESENT,
  FLAG_USER_VERIFIED,
  verifyAssertion,
} from './webauthn.js';

const ORIGIN = 'https://app.example.com';
const RP_ID = 'app.example.com';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

function assertion(options: { flags: number; signCount?: number; challenge?: string }) {
  const clientData = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: options.challenge ?? 'challenge-1',
      origin: ORIGIN,
    }),
  );
  const authData = Buffer.alloc(37);
  createHash('sha256').update(RP_ID).digest().copy(authData, 0);
  authData.writeUInt8(options.flags, 32);
  authData.writeUInt32BE(options.signCount ?? 0, 33);
  const signature = sign(
    'sha256',
    Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
    privateKey,
  );
  return {
    clientDataJSON: clientData.toString('base64url'),
    authenticatorData: authData.toString('base64url'),
    signature: signature.toString('base64url'),
  };
}

const expected = { challenge: 'challenge-1', origin: ORIGIN, rpId: RP_ID, publicKey, alg: 'ES256' };

describe('user presence and verification flags', () => {
  it('requires both UP and UV', () => {
    expect(() => {
      assertUserFlags(FLAG_USER_PRESENT | FLAG_USER_VERIFIED);
    }).not.toThrow();
    expect(() => {
      assertUserFlags(FLAG_USER_PRESENT);
    }).toThrow('user verification');
    expect(() => {
      assertUserFlags(FLAG_USER_VERIFIED);
    }).toThrow('user presence');
    expect(() => {
      assertUserFlags(0);
    }).toThrow('user presence');
  });

  it('rejects a correctly signed assertion made without user verification', () => {
    const ok = assertion({ flags: FLAG_USER_PRESENT | FLAG_USER_VERIFIED, signCount: 7 });
    expect(verifyAssertion(ok, expected)).toEqual({ signCount: 7 });
    expect(() => verifyAssertion(assertion({ flags: FLAG_USER_PRESENT }), expected)).toThrow(
      'user verification',
    );
    expect(() => verifyAssertion(assertion({ flags: 0 }), expected)).toThrow('user presence');
  });

  it('still rejects a wrong challenge', () => {
    const other = assertion({
      flags: FLAG_USER_PRESENT | FLAG_USER_VERIFIED,
      challenge: 'challenge-2',
    });
    expect(() => verifyAssertion(other, expected)).toThrow('challenge mismatch');
  });
});

describe('signature counter', () => {
  it('ignores authenticators that never count', () => {
    expect(counterRegressed(0, 0)).toBe(false);
    expect(counterRegressed(0n, 0)).toBe(false);
  });

  it('requires a strictly increasing counter once either side is non-zero', () => {
    expect(counterRegressed(5n, 6)).toBe(false);
    expect(counterRegressed(0n, 1)).toBe(false);
    expect(counterRegressed(5n, 5)).toBe(true);
    expect(counterRegressed(5n, 4)).toBe(true);
    expect(counterRegressed(5n, 0)).toBe(true);
  });
});

describe('clientDataChallenge', () => {
  it('reads the challenge used to look up a discoverable (usernameless) login', () => {
    const { clientDataJSON } = assertion({ flags: 0, challenge: 'abc_-123' });
    expect(clientDataChallenge(clientDataJSON)).toBe('abc_-123');
  });

  it('returns undefined for malformed client data', () => {
    expect(clientDataChallenge('not-json')).toBeUndefined();
    expect(
      clientDataChallenge(Buffer.from('{"challenge":5}').toString('base64url')),
    ).toBeUndefined();
  });
});
