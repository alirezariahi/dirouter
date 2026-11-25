/**
 * Management tokens (card 23.6): format, IP allow-list rules, and the guarantee behind read-only
 * tokens: every route that changes something needs a write permission, or is closed to tokens.
 */
import 'reflect-metadata';

import { generateKey } from '@dirouter/shared';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { HUMAN_ONLY_KEY, PERMISSION_KEY } from '../rbac/org.guard.js';
import {
  hashManagementToken,
  ipAllowed,
  isManagementToken,
  newManagementToken,
  parseIpRule,
} from './management-token.js';

describe('management token format', () => {
  it('has its own prefix, 256 random bits and a stored SHA-256', () => {
    const a = newManagementToken();
    const b = newManagementToken();
    expect(a.token).toMatch(/^drm_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.prefix).toBe(a.token.slice(0, 12));
    expect(a.hash).toBe(hashManagementToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isManagementToken(a.token)).toBe(true);
    // Virtual keys (dr-…), SCIM tokens and JWTs are not management tokens.
    for (const other of ['dr-abcdefgh-xyz', 'scim_abc', 'eyJhbGciOiJIUzI1NiJ9.e30.x'])
      expect(isManagementToken(other)).toBe(false);
  });
});

describe('IP allow-list', () => {
  it('parses addresses and CIDR ranges and rejects anything else', () => {
    expect(parseIpRule('10.0.0.1')).toEqual({ address: '10.0.0.1', family: 'ipv4' });
    expect(parseIpRule('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8, family: 'ipv4' });
    expect(parseIpRule('2001:db8::/32')).toEqual({
      address: '2001:db8::',
      prefix: 32,
      family: 'ipv6',
    });
    for (const bad of ['10.0.0.0/33', '2001:db8::/129', 'example.com', '10.0.0.1/8/1', '', '1.2.3'])
      expect(parseIpRule(bad), bad).toBeUndefined();
  });

  it('allows everything when empty and matches addresses, ranges and mapped IPv4', () => {
    expect(ipAllowed('203.0.113.9', [])).toBe(true);
    const rules = ['192.168.0.0/16', '10.1.2.3', '2001:db8::/48'];
    expect(ipAllowed('192.168.40.1', rules)).toBe(true);
    expect(ipAllowed('::ffff:192.168.40.1', rules)).toBe(true);
    expect(ipAllowed('10.1.2.3', rules)).toBe(true);
    expect(ipAllowed('10.1.2.4', rules)).toBe(false);
    expect(ipAllowed('2001:db8:0:1::5', rules)).toBe(true);
    expect(ipAllowed('2001:db9::5', rules)).toBe(false);
    expect(ipAllowed(undefined, rules)).toBe(false);
    expect(ipAllowed('not-an-ip', rules)).toBe(false);
  });
});

/**
 * Mutating routes that need only a `:read` permission and still change nothing a read-only token
 * should not do: both compute an answer from the request without storing anything.
 */
const READ_ONLY_POSTS = new Set([
  'PlaygroundController.compare',
  // The streamed playground (card 25.6): like compare, it stores nothing and spends through the
  // caller's own virtual key.
  'PlaygroundController.stream',
  'StatsController.simulate',
]);

describe('read-only scopes', () => {
  it('every organization route that changes something needs a write permission or is closed to tokens', async () => {
    const app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/none',
        VALKEY_URL: 'redis://127.0.0.1:1',
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'p'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
    );
    const offenders: string[] = [];
    let checked = 0;
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => object) | undefined;
        if (!controller) continue;
        const proto = controller.prototype as Record<string, unknown>;
        const classHumanOnly = Reflect.getMetadata(HUMAN_ONLY_KEY, controller) === true;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          const permission = Reflect.getMetadata(PERMISSION_KEY, handler) as string | undefined;
          // Only organization routes (OrgGuard declares a permission) are reachable with a token.
          if (method === undefined || permission === undefined) continue;
          checked++;
          const mutating = ![RequestMethod.GET, RequestMethod.HEAD, RequestMethod.OPTIONS].includes(
            method,
          );
          const humanOnly = classHumanOnly || Reflect.getMetadata(HUMAN_ONLY_KEY, handler) === true;
          const id = `${controller.name}.${name}`;
          if (mutating && permission.endsWith(':read') && !humanOnly && !READ_ONLY_POSTS.has(id))
            offenders.push(`${id} (${permission})`);
        }
      }
    }
    await app.close();
    expect(checked).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
