/**
 * AES-256-GCM encryption with key versioning, using only node:crypto.
 *
 * Ciphertext format: `v<version>.<base64url(iv ‖ ciphertext ‖ authTag)>`
 * - iv: 12 random bytes per encryption
 * - authTag: 16 bytes
 * The key version is inside the ciphertext so that old data remains
 * decryptable after a key rotation.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CIPHERTEXT_PATTERN = /^v(\d+)\.([A-Za-z0-9_-]+)$/;

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
}

export interface Keyring {
  /** Version of the key used for new encryption. */
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

/** A random 32-byte key encoded as base64. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

function decodeKey(encoded: string, version: number): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `master key v${version} must be ${KEY_BYTES} bytes (base64), got ${key.length}`,
    );
  }
  return key;
}

/**
 * Builds the keyring from the env value.
 *
 * Format: `1:<base64>,2:<base64>`; the highest version is the current key. A single key
 * without a version prefix is also accepted and treated as version 1.
 */
export function parseKeyring(value: string): Keyring {
  const entries = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new CryptoError('master key is empty');

  const keys = new Map<number, Buffer>();
  for (const entry of entries) {
    const [, versionText, versionedKey] = /^v?(\d+):(.+)$/.exec(entry) ?? [];
    const versioned = versionedKey !== undefined;
    const version = versioned ? Number(versionText) : 1;
    const encoded = versionedKey ?? entry;
    if (!versioned && entries.length > 1) {
      throw new CryptoError('every key must have a version prefix when more than one key is given');
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new CryptoError(`invalid key version: ${entry.split(':')[0] ?? ''}`);
    }
    if (keys.has(version)) throw new CryptoError(`duplicate key version: v${version}`);
    keys.set(version, decodeKey(encoded, version));
  }
  return { currentVersion: Math.max(...keys.keys()), keys };
}

/**
 * Encrypts a string. `aad` (optional) binds the ciphertext to a context (e.g.
 * a credential ID) so it cannot be swapped into another record.
 */
export function encrypt(keyring: Keyring, plaintext: string, aad?: string): string {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new CryptoError(`current key v${keyring.currentVersion} not found`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return `v${keyring.currentVersion}.${payload.toString('base64url')}`;
}

export function decrypt(keyring: Keyring, ciphertext: string, aad?: string): string {
  const [, versionText, encoded] = CIPHERTEXT_PATTERN.exec(ciphertext) ?? [];
  if (encoded === undefined) throw new CryptoError('malformed ciphertext');
  const version = Number(versionText);
  const key = keyring.keys.get(version);
  if (!key) throw new CryptoError(`key v${version} is not in the keyring`);

  const payload = Buffer.from(encoded, 'base64url');
  if (payload.length < IV_BYTES + TAG_BYTES) throw new CryptoError('ciphertext too short');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const body = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (error) {
    // The GCM error intentionally has no details: wrong key, or tampered data or aad.
    throw new CryptoError('decryption failed: wrong key or tampered data', { cause: error });
  }
}

/** Key version of a ciphertext. */
export function keyVersionOf(ciphertext: string): number {
  const match = CIPHERTEXT_PATTERN.exec(ciphertext);
  if (!match) throw new CryptoError('malformed ciphertext');
  return Number(match[1]);
}

/** true if the ciphertext was encrypted with a key other than the current one and must be re-encrypted. */
export function needsReencryption(keyring: Keyring, ciphertext: string): boolean {
  return keyVersionOf(ciphertext) !== keyring.currentVersion;
}
