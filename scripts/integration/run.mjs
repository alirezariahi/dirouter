/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GenericContainer, Wait } from 'testcontainers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const containers = [];
const children = new Set();

function run(command, args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    children.add(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) resolveRun();
      else
        reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal ?? 'unknown'})`));
    });
  });
}

async function stop() {
  for (const child of children) child.kill('SIGTERM');
  for (const container of containers.reverse()) {
    try {
      await container.stop({ timeout: 10_000 });
    } catch (error) {
      console.error('Could not stop an integration container:', error);
    }
  }
}

let postgres;
let valkey;
try {
  console.log('Starting disposable PostgreSQL 17 and Valkey 8 containers...');
  [postgres, valkey] = await Promise.all([
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({
        POSTGRES_USER: 'dirouter',
        POSTGRES_PASSWORD: 'integration-only-password',
        POSTGRES_DB: 'dirouter_integration',
      })
      .withExposedPorts(5432)
      .withHealthCheck({
        test: ['CMD-SHELL', 'pg_isready -U dirouter -d dirouter_integration'],
        interval: 1_000,
        timeout: 3_000,
        retries: 30,
        startPeriod: 1_000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .withStartupTimeout(120_000)
      .start(),
    new GenericContainer('valkey/valkey:8-alpine')
      .withExposedPorts(6379)
      .withHealthCheck({
        test: ['CMD', 'valkey-cli', 'ping'],
        interval: 1_000,
        timeout: 3_000,
        retries: 30,
        startPeriod: 1_000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .withStartupTimeout(120_000)
      .start(),
  ]);
  containers.push(postgres, valkey);

  const databaseName = 'dirouter_integration';
  const databaseUrl = `postgresql://dirouter:integration-only-password@${postgres.getHost()}:${postgres.getMappedPort(5432)}/${databaseName}`;
  const valkeyUrl = `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`;
  const integrationEnv = {
    INTEGRATION_DATABASE_URL: databaseUrl,
    INTEGRATION_VALKEY_URL: valkeyUrl,
    INTEGRATION_DATABASE_NAME: databaseName,
    POSTGRES_CONTAINER: postgres.getId(),
    VALKEY_CONTAINER: valkey.getId(),
  };

  await run('pnpm', [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@dirouter/shared',
    '--filter=@dirouter/worker^...',
    '--filter=@dirouter/control-api^...',
    '--filter=@dirouter/gateway^...',
  ]);
  await run('node', ['--test', 'scripts/ci/services.integration.mjs'], integrationEnv);
  await run('pnpm', ['--filter', '@dirouter/db', 'exec', 'prisma', 'migrate', 'deploy'], {
    DATABASE_URL: databaseUrl,
  });
  for (const packageName of ['@dirouter/worker', '@dirouter/control-api', '@dirouter/gateway']) {
    await run('pnpm', ['--filter', packageName, 'run', 'test:integration'], integrationEnv);
  }
  console.log('All integration suites passed.');
} finally {
  await stop();
}
