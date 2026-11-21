/**
 * Outbound URL policy for notification channels (card 16.2); free of framework imports.
 *
 * Channel URLs are entered by organization admins and fetched by the server, so they are a
 * server-side request forgery vector. The policy:
 * - always: an absolute http(s) URL without embedded credentials;
 * - in production: https only, and every address the host resolves to must be public
 *   (no loopback, private, link-local, carrier-grade NAT, metadata or multicast ranges);
 * - in development: private hosts are allowed, because the dev stack posts to local mock services.
 *
 * The same helper is duplicated in apps/worker/src/alerts.ts (the worker cannot import from this
 * app); keep the two in sync.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast and reserved
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // unique local, includes fd00:ec2::254
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

/** True for any address a production server must not be made to call. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:7f00:1`) is judged by its IPv4 address.
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (mapped) {
    if (mapped[1]) return blocked.check(mapped[1], 'ipv4');
    const high = Number.parseInt(mapped[2] ?? '0', 16);
    const low = Number.parseInt(mapped[3] ?? '0', 16);
    return blocked.check(
      `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`,
      'ipv4',
    );
  }
  return blocked.check(address, 'ipv6');
}

export type UrlCheck = { ok: true } | { ok: false; error: string };

/** Syntax-level check, usable when a channel is saved (no network access). */
export function checkUrlSyntax(raw: unknown, production: boolean): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'url must be a string' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, error: 'url must use http or https' };
  if (url.username || url.password) return { ok: false, error: 'url must not contain credentials' };
  if (production && url.protocol !== 'https:') return { ok: false, error: 'url must use https' };
  return { ok: true };
}

export interface UrlPolicyOptions {
  /** Defaults to NODE_ENV === 'production'. */
  production?: boolean | undefined;
  /** Injected for tests; defaults to the system resolver. */
  lookup?: ((host: string) => Promise<{ address: string }[]>) | undefined;
}

/** Full check right before a request: syntax, then (production) every resolved address. */
export async function checkOutboundUrl(
  raw: unknown,
  options: UrlPolicyOptions = {},
): Promise<UrlCheck> {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const syntax = checkUrlSyntax(raw, production);
  if (!syntax.ok || !production) return syntax;
  // URL keeps brackets around IPv6 literals.
  const host = new URL(raw as string).hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      const lookup = options.lookup ?? ((name: string) => dnsLookup(name, { all: true }));
      addresses = (await lookup(host)).map((entry) => entry.address);
    } catch {
      return { ok: false, error: 'url host could not be resolved' };
    }
  }
  if (addresses.length === 0) return { ok: false, error: 'url host could not be resolved' };
  if (addresses.some(isBlockedAddress))
    return { ok: false, error: 'url host resolves to a private or reserved address' };
  return { ok: true };
}
