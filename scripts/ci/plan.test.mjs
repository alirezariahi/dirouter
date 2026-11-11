import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { plan } from './plan.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const push = { eventName: 'push', event: { before: base }, ref: 'refs/heads/main', head };

function fixture({ files = [], packages = [], missingHistory = false } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'pnpm') return JSON.stringify({ packages });
    if (args[0] === 'merge-base') {
      if (missingHistory) throw new Error('Missing commit');
      return base;
    }
    return files.join('\0');
  };
  return { calls, run };
}

test('an app change builds only that image and uses the full commit range', () => {
  const { run, calls } = fixture({
    files: ['apps/gateway/src/main.ts'],
    packages: ['@dirouter/gateway'],
  });
  const result = plan(push, run);
  assert.equal(result.filter, `...[${base}...${head}]`);
  assert.deepEqual(
    result.matrix.include.map(({ app }) => app),
    ['gateway'],
  );
  assert.ok(calls.at(-1).includes(`--filter=...[${base}...${head}]`));
});

test('a shared change includes the dependent apps selected by Turbo', () => {
  const { run } = fixture({
    files: ['packages/shared/src/money.ts'],
    packages: [
      '@dirouter/shared',
      '@dirouter/gateway',
      '@dirouter/control-api',
      '@dirouter/worker',
      '@dirouter/mock-provider',
    ],
  });
  assert.deepEqual(
    plan(push, run).matrix.include.map(({ app }) => app),
    ['gateway', 'control-api', 'worker', 'mock-provider'],
  );
});

test('documentation-only changes skip package checks and images', () => {
  const { run } = fixture({ files: ['docs/ci.md'] });
  const result = plan(push, run);
  assert.equal(result.hasImages, false);
  assert.equal(result.hasPackages, false);
});

test('Docker and nginx changes rebuild their respective images', () => {
  for (const file of [
    'deploy/docker/dashboard.Dockerfile',
    'deploy/docker/nginx/dashboard.conf.template',
  ]) {
    assert.deepEqual(
      plan(push, fixture({ files: [file] }).run).matrix.include.map(({ app }) => app),
      ['dashboard'],
    );
  }
  assert.equal(
    plan(push, fixture({ files: ['deploy/docker/node.Dockerfile'] }).run).matrix.include.length,
    4,
  );
  assert.equal(plan(push, fixture({ files: ['.dockerignore'] }).run).matrix.include.length, 6);
});

test('shared root configuration and CI changes check and build everything', () => {
  for (const file of [
    'pnpm-lock.yaml',
    'package.json',
    'turbo.json',
    '.github/workflows/ci.yml',
    'scripts/ci/plan.mjs',
  ]) {
    const result = plan(push, fixture({ files: [file] }).run);
    assert.equal(result.filter, '*');
    assert.equal(result.matrix.include.length, 6);
  }
});

test('migration image follows database changes and its Dockerfile', () => {
  assert.deepEqual(
    plan(push, fixture({ files: ['deploy/docker/migrate.Dockerfile'] }).run).matrix.include.map(
      ({ app }) => app,
    ),
    ['migrate'],
  );
  assert.ok(
    plan(
      push,
      fixture({ files: ['packages/db/prisma/schema.prisma'], packages: ['@dirouter/db'] }).run,
    ).matrix.include.some(({ app }) => app === 'migrate'),
  );
});

test('manual runs, initial pushes, releases and unavailable history check everything', () => {
  for (const input of [
    { ...push, eventName: 'workflow_dispatch' },
    { ...push, event: { before: '0'.repeat(40) } },
    { ...push, event: {} },
    { ...push, ref: 'refs/tags/v1.2.3' },
    { ...push, ref: 'refs/tags/v1.2.3-rc.1+build.7' },
  ])
    assert.equal(plan(input, fixture().run).filter, '*');
  assert.equal(plan(push, fixture({ missingHistory: true }).run).filter, '*');
});

test('PRs compare their base to the checked-out merge commit', () => {
  const { run, calls } = fixture();
  const result = plan(
    { ...push, eventName: 'pull_request', event: { pull_request: { base: { sha: base } } } },
    run,
  );
  assert.deepEqual(calls[0], ['git', 'merge-base', base, head]);
  assert.equal(result.filter, `...[${base}...${head}]`);
});

test('invalid version tags fail rather than publishing a misleading release', () => {
  for (const tag of ['vfoo', 'v1.2', 'v01.2.3', 'v1.2.3-01']) {
    assert.throws(() => plan({ ...push, ref: `refs/tags/${tag}` }, fixture().run), /semver/);
  }
});

test('real Git and Turbo select only a changed app, expand shared dependents and skip docs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dirouter-ci-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const turbo = resolve('node_modules/.bin/turbo');
  const run = (command, args) =>
    execFileSync(command === 'pnpm' ? turbo : command, command === 'pnpm' ? args.slice(2) : args, {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json']) {
    copyFileSync(file, join(directory, file));
  }
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      mkdirSync(join(directory, group, name), { recursive: true });
      copyFileSync(join(group, name, 'package.json'), join(directory, group, name, 'package.json'));
    }
  }
  const commit = () => {
    run('git', ['add', '.']);
    run('git', [
      '-c',
      'user.name=CI',
      '-c',
      'user.email=ci@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'CI test fixture',
    ]);
    return run('git', ['rev-parse', 'HEAD']);
  };
  run('git', ['init', '-q', '--initial-branch=main']);
  let before = commit();
  const changedPlan = (file) => {
    writeFileSync(join(directory, file), 'changed\n');
    const after = commit();
    const result = plan({ ...push, event: { before }, head: after }, run);
    before = after;
    return result;
  };
  assert.deepEqual(
    changedPlan('apps/gateway/change.txt').matrix.include.map(({ app }) => app),
    ['gateway'],
  );
  assert.deepEqual(
    changedPlan('packages/shared/change.txt').matrix.include.map(({ app }) => app),
    ['gateway', 'control-api', 'worker', 'mock-provider'],
  );
  const documentation = changedPlan('README.md');
  assert.equal(documentation.hasImages, false);
  assert.equal(documentation.hasPackages, false);
});
