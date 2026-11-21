/** Periodic health probes: thresholds, auto disable/enable, lock and sample storage (card 12.3). */
import type { ConfigSnapshot, ProviderConfig } from '@dirouter/contracts';
import { HealthRegistry, type HealthChange } from '@dirouter/routing';
import { createLogger, generateKey, parseKeyring } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import {
  HEALTH_PROBE_LOCK_KEY,
  HEALTH_SAMPLES_KEY,
  HealthProber,
  type ProbeRedis,
} from './health-probe.js';
import type { ProbeResult } from './probe.js';

const keyring = parseKeyring(generateKey());
const logger = createLogger({ service: 'test', level: 'silent' });

const provider = (id: string, credentials: string[], enabled = true): ProviderConfig =>
  ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai',
    name: id,
    baseUrl: 'http://upstream.invalid/v1',
    enabled,
    options: {},
    credentials: credentials.map((c) => ({
      id: c,
      name: c,
      secret: 'unused',
      enabled: true,
      weight: 1,
    })),
  }) as unknown as ProviderConfig;

const snapshot = (
  providers: ProviderConfig[],
  healthProbe: Record<string, unknown> | undefined,
): ConfigSnapshot =>
  ({
    providers,
    settings: { ...(healthProbe ? { healthProbe } : {}) },
  }) as unknown as ConfigSnapshot;

const ok: ProbeResult = { ok: true, status: 200, latencyMs: 12, models: [] };
const authError: ProbeResult = {
  ok: false,
  status: 401,
  latencyMs: 8,
  error: { class: 'auth', message: 'invalid api key' },
  models: [],
};
const outage: ProbeResult = {
  ok: false,
  status: 503,
  latencyMs: 30,
  error: { class: 'server', message: 'unavailable' },
  models: [],
};

function fakeRedis(lockFree = true) {
  const lists = new Map<string, string[]>();
  const sets: string[] = [];
  const redis: ProbeRedis = {
    set: (key) => {
      sets.push(key);
      return Promise.resolve(lockFree ? 'OK' : null);
    },
    lpush: (key, ...values) => {
      const list = lists.get(key) ?? [];
      list.unshift(...values);
      lists.set(key, list);
      return Promise.resolve(list.length);
    },
    ltrim: () => Promise.resolve('OK'),
  };
  return { redis, lists, sets };
}

function setup(
  results: Record<string, ProbeResult[]>,
  // `null` means the snapshot has no healthProbe block at all (the default deployment).
  settings: Record<string, unknown> | null = { enabled: true, failureThreshold: 2 },
  extra: { redis?: ProbeRedis; providers?: ProviderConfig[] } = {},
) {
  const changes: HealthChange[] = [];
  const health = new HealthRegistry({ onChange: (c) => changes.push(c) });
  const calls: string[] = [];
  const prober = new HealthProber({
    snapshot: () =>
      snapshot(extra.providers ?? [provider('p1', Object.keys(results))], settings ?? undefined),
    health,
    keyring,
    logger,
    instance: 'test',
    ...(extra.redis ? { redis: extra.redis } : {}),
    probe: (_provider, credentialId) => {
      calls.push(credentialId);
      const queue = results[credentialId] ?? [];
      return Promise.resolve(queue.length > 1 ? (queue.shift() as ProbeResult) : (queue[0] ?? ok));
    },
  });
  return { prober, health, changes, calls };
}

describe('HealthProber', () => {
  it('does nothing while disabled, so probing has no cost by default', async () => {
    const off = setup({ c1: [ok] }, null);
    expect(await off.prober.round()).toEqual([]);
    const explicit = setup({ c1: [ok] }, { enabled: false });
    expect(await explicit.prober.round()).toEqual([]);
    expect(off.calls).toEqual([]);
    expect(explicit.calls).toEqual([]);
  });

  it('disables a credential only after the configured number of consecutive auth failures', async () => {
    const t = setup({ c1: [authError] });
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(true);
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(false);
    expect(t.health.credentialDisabledReason('c1')).toContain('health_probe');
    expect(t.changes).toEqual([
      expect.objectContaining({ kind: 'credential_disabled', credentialId: 'c1' }),
    ]);
    // A third failure does not publish the same change again.
    await t.prober.round();
    expect(t.changes).toHaveLength(1);
  });

  it('a success between failures resets the streak', async () => {
    const t = setup({ c1: [authError, ok, authError, ok] });
    await t.prober.round();
    await t.prober.round();
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(true);
  });

  it('does not disable credentials during a provider outage', async () => {
    const t = setup({ c1: [outage] }, { enabled: true, failureThreshold: 1 });
    await t.prober.round();
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(true);
    expect(t.changes).toEqual([]);
  });

  it('re-enables a disabled credential when it answers again', async () => {
    const t = setup({ c1: [authError, authError, ok] });
    await t.prober.round();
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(false);
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(true);
    expect(t.changes.at(-1)).toEqual({ kind: 'reset', scope: 'credential', id: 'c1' });
  });

  it('honours successThreshold before restoring', async () => {
    const t = setup(
      { c1: [authError, ok] },
      { enabled: true, failureThreshold: 1, successThreshold: 2 },
    );
    await t.prober.round();
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(false);
    await t.prober.round();
    expect(t.health.credentialAvailable('c1', 'm')).toBe(true);
  });

  it('skips disabled providers and caps the calls per round with a rotating window', async () => {
    const providers = [provider('p1', ['a', 'b', 'c']), provider('off', ['z'], false)];
    const t = setup({}, { enabled: true, maxPerRound: 2 }, { providers });
    await t.prober.round();
    await t.prober.round();
    expect(t.calls).toEqual(['a', 'b', 'c', 'a']);
  });

  it('stores samples for the uptime history and takes the shared lock', async () => {
    const { redis, lists, sets } = fakeRedis();
    const t = setup({ c1: [ok], c2: [outage] }, { enabled: true }, { redis });
    const samples = await t.prober.round();
    expect(sets).toEqual([HEALTH_PROBE_LOCK_KEY]);
    expect(samples.map((s) => [s.credentialId, s.ok, s.errorClass])).toEqual([
      ['c1', true, undefined],
      ['c2', false, 'server'],
    ]);
    const stored = (lists.get(HEALTH_SAMPLES_KEY) ?? []).map(
      (raw) => JSON.parse(raw) as { credentialId: string; providerId: string },
    );
    expect(stored.map((s) => s.credentialId).sort()).toEqual(['c1', 'c2']);
    expect(stored.every((s) => s.providerId === 'p1')).toBe(true);
  });

  it('does not probe when another replica holds the lock', async () => {
    const { redis } = fakeRedis(false);
    const t = setup({ c1: [ok] }, { enabled: true }, { redis });
    expect(await t.prober.round()).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});
