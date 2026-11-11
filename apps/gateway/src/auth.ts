/**
 * Virtual key authentication (card 4.3): HMAC of the key and lookup in the in-memory snapshot, no I/O.
 */
import { BlockList, isIP } from 'node:net';

import type { VirtualKeyConfig } from '@dirouter/contracts';
import {
  AuthenticationError,
  ForbiddenError,
  hashApiKey,
  timingSafeEqualHex,
} from '@dirouter/shared';

import type { LoadedConfig } from './config-store.js';

const allowlists = new WeakMap<VirtualKeyConfig, BlockList>();

function allowlistFor(key: VirtualKeyConfig): BlockList {
  let list = allowlists.get(key);
  if (!list) {
    list = new BlockList();
    for (const entry of key.ipAllowlist) {
      const [address = '', prefix] = entry.split('/');
      const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
      if (prefix !== undefined) list.addSubnet(address, Number(prefix), family);
      else list.addAddress(address, family);
    }
    allowlists.set(key, list);
  }
  return list;
}

export function extractApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth))
    return auth.replace(/^Bearer\s+/i, '').trim();
  const xKey = headers['x-api-key'];
  return typeof xKey === 'string' ? xKey.trim() : undefined;
}

export function authenticate(
  config: LoadedConfig,
  rawKey: string | undefined,
  pepper: string,
  ip: string,
  now = Date.now(),
): VirtualKeyConfig {
  if (!rawKey)
    throw new AuthenticationError('unauthenticated', {
      message: 'Missing API key (Authorization: Bearer or x-api-key)',
    });
  const hash = hashApiKey(rawKey, pepper);
  const key = config.keysByHash.get(hash);
  // The Map lookup only finds the candidate; final verification is a constant-time comparison.
  if (!key?.enabled || !timingSafeEqualHex(hash, key.hash))
    throw new AuthenticationError('invalid_api_key');
  if (key.expiresAt && Date.parse(key.expiresAt) <= now)
    throw new AuthenticationError('api_key_expired');
  if (key.ipAllowlist.length > 0) {
    const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (!allowlistFor(key).check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')) {
      throw new ForbiddenError('forbidden', { message: 'IP address not allowed for this key' });
    }
  }
  return key;
}
