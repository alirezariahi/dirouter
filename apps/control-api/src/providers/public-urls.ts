/** SSRF guard for tenant-configured upstream URLs (card 22.3). */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { DiRouterError, isBlockedAddress } from '@dirouter/shared';

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

const masked = (value: string) => value.replace(/\/\/[^@/]*@/, '//***@');

/** Every URL must resolve, and only to public addresses. */
export async function assertPublicUrls(
  urls: (string | null | undefined)[],
  resolve: Resolver = systemResolver,
): Promise<void> {
  for (const value of urls) {
    if (typeof value !== 'string' || value === '') continue;
    let host: string;
    try {
      host = new URL(value).hostname.replace(/^\[|\]$/g, '');
    } catch {
      throw new DiRouterError('validation_failed', { message: `invalid URL: ${masked(value)}` });
    }
    let addresses: string[];
    try {
      addresses = isIP(host) !== 0 ? [host] : await resolve(host);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress))
      throw new DiRouterError('validation_failed', {
        message: `${masked(value)} must resolve to a public address`,
      });
  }
}
