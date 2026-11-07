/** قانون پذیرش snapshot در گیت‌وی (کارت ۴.۲). */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { HealthRegistry } from '@dirouter/routing';
import { createLogger, generateKey, parseKeyring } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import { ConfigStore } from './config-store.js';

const snap = (version: number, checksum = 'a'.repeat(64)): ConfigSnapshotInput => ({
  schemaVersion: 1,
  version,
  generatedAt: new Date().toISOString(),
  checksum,
  providers: [],
  models: [],
  combos: [],
  aliases: [],
  virtualKeys: [],
  settings: {},
});

async function store() {
  return new ConfigStore({
    dataDir: await mkdtemp(join(tmpdir(), 'cfg-')),
    keyring: parseKeyring(generateKey()),
    health: new HealthRegistry(),
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
}

describe('snapshot acceptance', () => {
  it('a disk snapshot only replaces an older one', async () => {
    const s = await store();
    expect(s.apply(snap(10), 'disk')).toBe(true);
    expect(s.apply(snap(9), 'disk')).toBe(false);
    expect(s.apply(snap(11), 'disk')).toBe(true);
  });

  it('the control plane is authoritative, even with a lower version than a dev snapshot', async () => {
    const s = await store();
    s.apply(snap(1_794_000_000), 'disk');
    expect(s.apply(snap(3, 'b'.repeat(64)), 'control-api')).toBe(true);
    expect(s.current?.version).toBe(3);
    // همان نسخه و checksum دوباره اعمال نمی‌شود.
    expect(s.apply(snap(3, 'b'.repeat(64)), 'control-api')).toBe(false);
  });

  it('an invalid snapshot never replaces the current one', async () => {
    const s = await store();
    s.apply(snap(5), 'control-api');
    expect(s.apply({ ...snap(6), providers: 'broken' }, 'control-api')).toBe(false);
    expect(s.current?.version).toBe(5);
  });
});
