/**
 * Which proxies may tell control-api the client's address (`X-Forwarded-For`), from TRUST_PROXY.
 * The client address feeds the management-token IP allow-list, login limits and the audit log, so
 * trusting every hop (the old `trustProxy: true`) let a client pick its own address whenever a
 * proxy appends to the header instead of replacing it.
 *
 * - a hop count (`1`, the default: the bundled Traefik in front of control-api), taking the
 *   address that many proxies back from the right of the header;
 * - a comma list of addresses or CIDR ranges of the proxies to trust;
 * - `true` (trust every hop; only behind a proxy that overwrites the header) or `false` (ignore the
 *   header and use the connection's address).
 */
import { isIP } from 'node:net';

/** What fastify's `trustProxy` option takes. */
export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean);

/**
 * Trusts the `hops` proxies nearest to control-api, whatever their address. fastify 5 turns a
 * plain number into "trust nobody" (it ignores X-Forwarded-Proto too), so the count is a function:
 * proxy-addr asks about each hop from the socket outwards, 0 being the direct peer.
 */
export function trustHops(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops;
}

export function parseTrustProxy(value: string | undefined): TrustProxy {
  const text = (value ?? '').trim();
  if (text === '') return trustHops(1);
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops > 100) throw new Error(`TRUST_PROXY: hop count ${text} is too large`);
    return hops === 0 ? false : trustHops(hops);
  }
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [address = '', prefix, extra] = entry.split('/');
    const version = isIP(address);
    if (
      version === 0 ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error(
        `TRUST_PROXY: '${entry}' is not a hop count, true/false, or an IP address or CIDR range`,
      );
  }
  return entries;
}
