import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { check, discoverEnvironment, documentedVariables, run } from './env-docs.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dirouter-env-docs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    'apps/demo/src',
    'packages/shared/src',
    'apps/mock-provider/src',
    'apps/demo/node_modules/dependency',
    'apps/demo/dist',
  ]) {
    mkdirSync(join(directory, path), { recursive: true });
  }
  return directory;
}

test('discovers direct, bracket, Vite, Zod and Compose reads', (t) => {
  const directory = fixture(t);
  writeFileSync(
    join(directory, 'apps/demo/src/main.ts'),
    `process.env.DIRECT; process.env['BRACKET']; import.meta.env.VITE_PUBLIC;\n`,
  );
  writeFileSync(
    join(directory, 'packages/shared/src/env.ts'),
    `export const schema = z.object({\n  FROM_SCHEMA: z.string(),\n});\n`,
  );
  writeFileSync(
    join(directory, 'compose.yaml'),
    `services:\n  demo:\n    environment:\n      FROM_COMPOSE: \${FROM_COMPOSE:-value}\n      IGNORED: $\${CONTAINER_ONLY}\n`,
  );
  writeFileSync(
    join(directory, 'apps/mock-provider/src/main.ts'),
    `baseEnvSchema.extend({ PORT: envPort(8090), MOCK_DEFAULT: z.string().optional() });\n`,
  );
  const result = discoverEnvironment(directory);
  assert.deepEqual(
    [...result.keys()],
    ['BRACKET', 'DIRECT', 'FROM_COMPOSE', 'FROM_SCHEMA', 'MOCK_DEFAULT', 'VITE_PUBLIC'],
  );
});

test('does not scan generated code or dependencies', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'apps/demo/node_modules/dependency/index.js'), 'process.env.NOPE');
  writeFileSync(join(directory, 'apps/demo/dist/main.js'), 'process.env.NOPE');
  assert.equal(discoverEnvironment(directory).size, 0);
});

test('fails for both missing and stale documentation entries', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'apps/demo/src/main.ts'), 'process.env.CURRENT');
  const reference = join(directory, 'reference.md');
  writeFileSync(reference, '- `CURRENT`\n- `REMOVED`\n');
  assert.deepEqual(check({ rootDirectory: directory, referencePath: reference }).missing, []);
  assert.deepEqual(check({ rootDirectory: directory, referencePath: reference }).unknown, [
    'REMOVED',
  ]);
  writeFileSync(reference, '- `REMOVED`\n');
  assert.deepEqual(check({ rootDirectory: directory, referencePath: reference }).missing, [
    'CURRENT',
  ]);
  const previousExitCode = process.exitCode;
  const write = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => {
    process.stderr.write = write;
    process.exitCode = previousExitCode;
  });
  run(check({ rootDirectory: directory, referencePath: reference }));
  assert.equal(process.exitCode, 1);
});

test('requires a structured variable entry, not incidental prose', () => {
  assert.deepEqual([...documentedVariables('Mentioning CURRENT in prose is insufficient')], []);
  assert.deepEqual(
    [...documentedVariables('| `CURRENT` | description |\n- `OTHER`')],
    ['CURRENT', 'OTHER'],
  );
});

test('the actual CLI succeeds and terminates', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/ci/check-env-docs.mjs')], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Environment reference verified/);
});
