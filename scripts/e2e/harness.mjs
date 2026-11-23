/* eslint-disable no-console */
/**
 * Shared helpers for the end-to-end suites (sprint 3 onwards): every call goes through Traefik on
 * the development stack (`make up && make seed`) exactly like a client would.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeEnv = { ...process.env, GRAFANA_ADMIN_PASSWORD: 'e2e-not-used' };
const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.dev.yaml'];

export const urls = {
  gateway: process.env.E2E_GATEWAY_URL ?? 'http://api.localhost',
  admin: process.env.E2E_ADMIN_URL ?? 'http://admin.localhost',
  mock: process.env.E2E_MOCK_URL ?? 'http://mock.localhost',
};

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs SQL in the dev Postgres container; returns psql's unaligned output. */
export async function sql(query) {
  const { stdout } = await exec(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'dirouter',
      '-d',
      'dirouter',
      '-Atc',
      query,
    ],
    { cwd: root, env: composeEnv, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

export async function valkey(...args) {
  const { stdout } = await exec(
    'docker',
    [...compose, 'exec', '-T', 'valkey', 'valkey-cli', ...args],
    {
      cwd: root,
      env: composeEnv,
    },
  );
  return stdout.trim();
}

export async function request(url, options = {}, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), ...options });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (expected !== undefined && expected !== null)
    assert.equal(
      response.status,
      expected,
      `${options.method ?? 'GET'} ${url}: ${text.slice(0, 600)}`,
    );
  return { response, body, text };
}

export async function waitFor(description, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
}

export async function readEnv(file) {
  return Object.fromEntries(
    (await readFile(resolve(root, file), 'utf8'))
      .trim()
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/** Control-api client bound to a bearer token (expected status defaults to 200; null skips). */
export function adminClient(token) {
  const call = (method, path, body, expected = 200, bearer = token) =>
    request(
      `${urls.admin}/api/v1/${path}`,
      {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      expected,
    );
  return call;
}

export async function login(email, password) {
  const { body } = await adminClient()('POST', 'auth/login', { email, password });
  return body.accessToken;
}

export const configVersion = async () =>
  (await request(`${urls.gateway}/readyz`, {}, 200)).body.configVersion;

/** Runs a control-plane change and waits until the gateway has loaded the resulting snapshot. */
export async function published(change) {
  const before = await configVersion();
  const result = await change();
  await waitFor('gateway to load the new snapshot', async () => (await configVersion()) > before);
  return result;
}

export function chat(key, body, headers = {}) {
  return request(`${urls.gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });
}

/** Scenario runner: filters by the CLI arguments, records results and prints a JSON summary. */
export function createRunner(argv = process.argv.slice(2)) {
  const results = [];
  const cleanups = [];
  async function scenario(name, run) {
    if (argv.length > 0 && !argv.some((part) => name.includes(part))) return;
    const started = Date.now();
    try {
      await run();
      results.push({ name, status: 'passed', durationMs: Date.now() - started });
      console.log(`PASS ${name}`);
    } catch (error) {
      if (error?.code === 'E2E_SKIP') {
        results.push({ name, status: 'skipped', reason: error.message });
        console.log(`SKIP ${name}: ${error.message}`);
        return;
      }
      results.push({ name, status: 'failed', durationMs: Date.now() - started });
      console.log(
        `FAIL ${name}\n     ${String(error?.stack ?? error)
          .split('\n')
          .slice(0, 6)
          .join('\n     ')}`,
      );
    }
  }
  async function finish(crashed) {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error('cleanup failed:', error instanceof Error ? error.message : error);
      }
    }
    const count = (status) => results.filter((r) => r.status === status).length;
    console.log(
      JSON.stringify(
        { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), results },
        null,
        2,
      ),
    );
    if (crashed || count('failed') > 0) process.exitCode = 1;
  }
  return { scenario, cleanups, finish };
}

export function skip(message) {
  const error = new Error(message);
  error.code = 'E2E_SKIP';
  throw error;
}
