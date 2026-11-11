import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  costForTokens,
  decrypt,
  encrypt,
  formatUsd,
  hashApiKey,
  parseKeyring,
} from '../../packages/shared/dist/index.js';

const exec = promisify(execFile);
const postgres = process.env.POSTGRES_CONTAINER;
const valkey = process.env.VALKEY_CONTAINER;
assert.ok(postgres, 'POSTGRES_CONTAINER must identify an isolated PostgreSQL 17 container');
assert.ok(valkey, 'VALKEY_CONTAINER must identify an isolated Valkey container');

async function docker(...args) {
  const { stdout } = await exec('docker', ['exec', ...args], { timeout: 10_000 });
  return stdout.trim();
}

test('PostgreSQL preserves shared money, key hashes and encrypted credentials in a transaction', async () => {
  const keyring = parseKeyring(randomBytes(32).toString('base64'));
  const ciphertext = encrypt(keyring, 'ci-only-provider-key', 'credential-ci');
  const hash = hashApiKey('ci-only-virtual-key', 'ci-only-pepper');
  const cost = formatUsd(costForTokens(3, '0.01000000'));
  assert.equal(cost, '0.00000003');
  // All interpolated values are generated above (decimal/hex/base64url), never user input.
  const sql = `BEGIN;
    CREATE TEMP TABLE ci_roundtrip (cost NUMERIC(18,8), key_hash TEXT UNIQUE, secret TEXT);
    INSERT INTO ci_roundtrip VALUES ('${cost}', '${hash}', '${ciphertext}');
    SELECT cost::text || '|' || key_hash || '|' || secret FROM ci_roundtrip;
    ROLLBACK;`;
  const row = await docker(
    postgres,
    'psql',
    '-X',
    '-qAt',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'dirouter',
    '-d',
    process.env.INTEGRATION_DATABASE_NAME ?? 'dirouter_ci',
    '-c',
    sql,
  );
  const [storedCost, storedHash, storedCiphertext] = row.split('|');
  assert.equal(storedCost, cost);
  assert.equal(storedHash, hash);
  assert.equal(decrypt(keyring, storedCiphertext, 'credential-ci'), 'ci-only-provider-key');
});

test('Valkey supports expiring locks and atomic counters used by distributed limits', async (t) => {
  const prefix = `dirouter:ci:${randomBytes(8).toString('hex')}`;
  const command = (...args) => docker(valkey, 'valkey-cli', '--raw', ...args);
  t.after(() => command('DEL', `${prefix}:lock`, `${prefix}:rpm`));
  assert.equal(await command('SET', `${prefix}:lock`, 'owner', 'NX', 'PX', '60000'), 'OK');
  assert.equal(await command('SET', `${prefix}:lock`, 'other', 'NX', 'PX', '60000'), '');
  const ttl = Number(await command('PTTL', `${prefix}:lock`));
  assert.ok(ttl > 0 && ttl <= 60_000);
  const values = await Promise.all(
    Array.from({ length: 10 }, () => command('INCR', `${prefix}:rpm`)),
  );
  assert.deepEqual(
    values.map(Number).sort((a, b) => a - b),
    Array.from({ length: 10 }, (_, i) => i + 1),
  );
});
