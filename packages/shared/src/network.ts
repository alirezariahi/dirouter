/**
 * Addresses a server must not reach on a tenant's behalf (SSRF): private, loopback, link-local
 * (cloud metadata), carrier-grade NAT, benchmarking, multicast and their IPv6 equivalents.
 */
import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  BLOCKED.addSubnet(network, prefix, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return BLOCKED.check(mapped[1], 'ipv4');
  return BLOCKED.check(address, 'ipv6');
}
