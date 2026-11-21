/**
 * Minimal WebAuthn (passkey) verification (card 14.1): CBOR decoding, COSE → JWK, authenticator
 * data parsing and ES256/RS256 signature checks with node:crypto. Only the `none` and `packed`
 * attestation statements are accepted; that is enough for first-party passkeys (the browser
 * already proves possession of the private key during assertions).
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export class CborError extends Error {}

/** Decodes the subset of CBOR used by WebAuthn. */
export function cborDecode(buffer: Buffer, offset = 0): { value: unknown; offset: number } {
  const first = buffer[offset];
  if (first === undefined) throw new CborError('unexpected end of CBOR');
  const major = first >> 5;
  const additional = first & 31;
  let cursor = offset + 1;
  let length = additional;
  if (additional === 24) {
    length = buffer.readUInt8(cursor);
    cursor += 1;
  } else if (additional === 25) {
    length = buffer.readUInt16BE(cursor);
    cursor += 2;
  } else if (additional === 26) {
    length = buffer.readUInt32BE(cursor);
    cursor += 4;
  } else if (additional === 27) {
    length = Number(buffer.readBigUInt64BE(cursor));
    cursor += 8;
  } else if (additional >= 28) {
    throw new CborError('indefinite-length CBOR is not supported');
  }

  if (major === 0) return { value: length, offset: cursor };
  if (major === 1) return { value: -1 - length, offset: cursor };
  if (major === 2)
    return { value: buffer.subarray(cursor, cursor + length), offset: cursor + length };
  if (major === 3)
    return { value: buffer.toString('utf8', cursor, cursor + length), offset: cursor + length };
  if (major === 4) {
    const items: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = cborDecode(buffer, cursor);
      items.push(item.value);
      cursor = item.offset;
    }
    return { value: items, offset: cursor };
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < length; i++) {
      const key = cborDecode(buffer, cursor);
      const value = cborDecode(buffer, key.offset);
      map.set(key.value, value.value);
      cursor = value.offset;
    }
    return { value: map, offset: cursor };
  }
  if (major === 7) {
    if (additional === 20) return { value: false, offset: cursor };
    if (additional === 21) return { value: true, offset: cursor };
    if (additional === 22) return { value: null, offset: cursor };
  }
  throw new CborError(`unsupported CBOR major type ${String(major)}`);
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');
const fromB64url = (value: string) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface CoseKey {
  key: KeyObject;
  alg: 'ES256' | 'RS256';
}

/** COSE_Key (RFC 8152) → node KeyObject. */
export function coseToKey(cose: Map<unknown, unknown>): CoseKey {
  const kty = Number(cose.get(1));
  if (kty === 2) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Buffer) || !(y instanceof Buffer))
      throw new CborError('EC2 key needs x and y');
    return {
      key: createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) },
        format: 'jwk',
      }),
      alg: 'ES256',
    };
  }
  if (kty === 3) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Buffer) || !(e instanceof Buffer))
      throw new CborError('RSA key needs n and e');
    return {
      key: createPublicKey({
        key: { kty: 'RSA', n: b64url(n), e: b64url(e) },
        format: 'jwk',
      }),
      alg: 'RS256',
    };
  }
  throw new CborError(`unsupported COSE key type ${String(kty)}`);
}

export interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  cose?: Map<unknown, unknown>;
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new CborError('authenticator data too short');
  const rpIdHash = data.subarray(0, 32);
  const flags = data.readUInt8(32);
  const signCount = data.readUInt32BE(33);
  let offset = 37;
  let credentialId: Buffer | undefined;
  let cose: Map<unknown, unknown> | undefined;
  if ((flags & 0x40) !== 0) {
    // attested credential data
    offset += 16; // aaguid
    const length = data.readUInt16BE(offset);
    offset += 2;
    credentialId = data.subarray(offset, offset + length);
    offset += length;
    const decoded = cborDecode(data, offset);
    if (decoded.value instanceof Map) cose = decoded.value;
  }
  return {
    rpIdHash,
    flags,
    signCount,
    ...(credentialId ? { credentialId } : {}),
    ...(cose ? { cose } : {}),
  };
}

/** Authenticator data flag bits (WebAuthn section 6.1). */
export const FLAG_USER_PRESENT = 0x01;
export const FLAG_USER_VERIFIED = 0x04;

/**
 * A passkey stands in for password + second factor here, so both user presence (a touch) and user
 * verification (PIN or biometric) must have happened on the authenticator.
 */
export function assertUserFlags(flags: number): void {
  if ((flags & FLAG_USER_PRESENT) === 0) throw new CborError('user presence is required');
  if ((flags & FLAG_USER_VERIFIED) === 0) throw new CborError('user verification is required');
}

/**
 * Signature counter rule (WebAuthn section 7.2 step 21): when either side uses a counter, the
 * presented value must be strictly greater than the stored one; otherwise the credential may have
 * been cloned. Authenticators that always report zero (most synced passkeys) are exempt.
 */
export function counterRegressed(stored: number | bigint, presented: number | bigint): boolean {
  const before = BigInt(stored);
  const now = BigInt(presented);
  if (before === 0n && now === 0n) return false;
  return now <= before;
}

/** The challenge the browser signed, read from the (not yet verified) client data. */
export function clientDataChallenge(clientDataJSON: string): string | undefined {
  try {
    const parsed = JSON.parse(fromB64url(clientDataJSON).toString('utf8')) as {
      challenge?: unknown;
    };
    return typeof parsed.challenge === 'string' ? parsed.challenge : undefined;
  } catch {
    return undefined;
  }
}

export interface RegistrationInput {
  clientDataJSON: string;
  attestationObject: string;
}

export interface ParsedAttestation {
  credentialId: Buffer;
  publicKey: KeyObject;
  alg: 'ES256' | 'RS256';
  signCount: number;
}

export function verifyRegistration(
  input: RegistrationInput,
  expected: { challenge: string; origin: string; rpId: string },
): ParsedAttestation {
  const clientData = JSON.parse(fromB64url(input.clientDataJSON).toString('utf8')) as {
    type?: unknown;
    challenge?: unknown;
    origin?: unknown;
  };
  if (clientData.type !== 'webauthn.create') throw new CborError('wrong clientData type');
  if (clientData.challenge !== expected.challenge) throw new CborError('challenge mismatch');
  if (clientData.origin !== expected.origin) throw new CborError('origin mismatch');
  const attestation = cborDecode(fromB64url(input.attestationObject));
  if (!(attestation.value instanceof Map)) throw new CborError('invalid attestation object');
  const authData: unknown = attestation.value.get('authData');
  if (!(authData instanceof Buffer)) throw new CborError('missing authData');
  const parsed = parseAuthenticatorData(authData);
  if (!parsed.credentialId || !parsed.cose) throw new CborError('missing credential data');
  const rpIdHash = parsed.rpIdHash;
  // SHA-256 of the relying party ID.
  const expectedRp = createHash('sha256').update(expected.rpId).digest();
  if (!rpIdHash.equals(expectedRp)) throw new CborError('relying party mismatch');
  assertUserFlags(parsed.flags);
  const key = coseToKey(parsed.cose);
  return {
    credentialId: parsed.credentialId,
    publicKey: key.key,
    alg: key.alg,
    signCount: parsed.signCount,
  };
}

export function verifyAssertion(
  input: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  },
  expected: { challenge: string; origin: string; rpId: string; publicKey: KeyObject; alg: string },
): { signCount: number } {
  const clientData = JSON.parse(fromB64url(input.clientDataJSON).toString('utf8')) as {
    type?: unknown;
    challenge?: unknown;
    origin?: unknown;
  };
  if (clientData.type !== 'webauthn.get') throw new CborError('wrong clientData type');
  if (clientData.challenge !== expected.challenge) throw new CborError('challenge mismatch');
  if (clientData.origin !== expected.origin) throw new CborError('origin mismatch');
  const authData = fromB64url(input.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  const rpIdHash = createHash('sha256').update(expected.rpId).digest();
  if (!parsed.rpIdHash.equals(rpIdHash)) throw new CborError('relying party mismatch');
  assertUserFlags(parsed.flags);
  const clientHash = createHash('sha256').update(fromB64url(input.clientDataJSON)).digest();
  const signed = Buffer.concat([authData, clientHash]);
  const signature = fromB64url(input.signature);
  const ok = cryptoVerify(
    'sha256',
    signed,
    expected.alg === 'ES256' ? { key: expected.publicKey, dsaEncoding: 'der' } : expected.publicKey,
    signature,
  );
  if (!ok) throw new CborError('signature verification failed');
  return { signCount: parsed.signCount };
}

export const webauthnBytes = { fromB64url, b64url };
