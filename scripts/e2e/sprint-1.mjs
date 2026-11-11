/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...process.env, GRAFANA_ADMIN_PASSWORD: 'e2e-not-used' };
const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.dev.yaml'];
const gateway = process.env.E2E_GATEWAY_URL ?? 'http://api.localhost';
const admin = process.env.E2E_ADMIN_URL ?? 'http://admin.localhost';
const mock = process.env.E2E_MOCK_URL ?? 'http://mock.localhost';
const results = [];
const keys = [];
let token;
const stopped = new Set();
let firstConfigVersion = 0;

async function docker(service, args = [], options = {}) {
  return exec('docker', [...compose, ...args, service], { cwd: root, env, ...options });
}
async function containerExec(service, script) {
  return docker(service, ['exec', '-T', service, 'node', '--input-type=module', '-e', script]);
}
async function sql(query) {
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
    { cwd: root, env, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}
async function request(url, options = {}, expected) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (expected !== undefined)
    assert.equal(response.status, expected, `${options.method ?? 'GET'} ${url}: ${text}`);
  return { response, body };
}
async function waitFor(description, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
}
async function callAdmin(method, path, body, expected = 200) {
  return request(
    `${admin}/api/v1/${path}`,
    {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    expected,
  );
}
async function message(model, key, requestId, expected = 200) {
  return request(
    `${gateway}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
        'x-request-id': requestId,
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: 'user', content: `Sprint 1 ${requestId}` }],
      }),
    },
    expected,
  );
}
async function stats() {
  return (await request(`${mock}/__mock/stats`, {}, 200)).body;
}
async function health() {
  const script = `const r=await fetch('http://127.0.0.1:8080/internal/health',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}});console.log(await r.text());`;
  const { stdout } = await containerExec('gateway', script);
  return JSON.parse(stdout);
}
async function createKey(name, extra = {}) {
  const { body } = await callAdmin(
    'POST',
    'orgs/org_dev/keys',
    {
      name: `sprint1-e2e-${name}-${randomUUID().slice(0, 8)}`,
      projectId: 'prj_dev',
      allowedModels: ['mock/small', 'dev', 'mock/429', 'mock/claude', 'dev-429'],
      ...extra,
    },
    201,
  );
  assert.ok(body.key && body.id);
  keys.push(body.id);
  await waitFor(`snapshot for ${name}`, async () => {
    const ready = await request(`${gateway}/readyz`);
    return ready.body.configVersion > firstConfigVersion && ready.body;
  });
  firstConfigVersion = (await request(`${gateway}/readyz`, {}, 200)).body.configVersion;
  return body;
}
async function scenario(name, run) {
  const started = Date.now();
  await run();
  results.push({ name, status: 'passed', durationMs: Date.now() - started });
  console.log(`PASS ${name}`);
}

try {
  const ready = await request(`${gateway}/readyz`, {}, 200);
  firstConfigVersion = ready.body.configVersion;
  assert.equal(ready.body.controlApiSync, true);
  const seeded = await sql(
    "SELECT count(*) FROM providers WHERE id IN ('prv_mock','prv_mock-down','prv_mock-429') AND deleted_at IS NULL",
  );
  assert.equal(seeded, '3', 'Run the development seed before e2e (make seed)');

  const credentials = Object.fromEntries(
    (await readFile(resolve(root, '.data/seed-admin.env'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  const login = await callAdmin('POST', 'auth/login', {
    email: credentials.SEED_ADMIN_EMAIL,
    password: credentials.SEED_ADMIN_PASSWORD,
  });
  token = login.body.accessToken;
  const main = await createKey('main');

  await scenario('Anthropic input is translated to the OpenAI provider', async () => {
    await request(`${mock}/__mock/reset`, { method: 'POST' }, 200);
    const id = `e2e_translate_${randomUUID()}`;
    const { body } = await message('mock/small', main.key, id);
    assert.equal(body.type, 'message');
    assert.equal(body.content[0].type, 'text');
    assert.match(body.content[0].text, /Hello from/);
    const observed = await stats();
    assert.ok(observed.byKey['Bearer sk-mock'] >= 1);
    assert.equal(observed.last.at(-1).messages[0].role, 'user');
    assert.ok(observed.last.at(-1).model);
    assert.equal(observed.last.at(-1).stream, undefined);
  });

  await scenario('primary provider failure falls back to healthy target', async () => {
    await request(`${mock}/__mock/reset`, { method: 'POST' }, 200);
    const { response, body } = await message('dev', main.key, `e2e_fallback_${randomUUID()}`);
    assert.equal(response.headers.get('x-dirouter-provider'), 'mock');
    assert.match(body.content[0].text, /Hello from/);
    const observed = await stats();
    assert.ok(observed.byStatus['503'] >= 1, 'primary must actually fail');
    assert.ok(observed.byKey['Bearer sk-mock'] >= 1, 'healthy fallback must be called');
  });

  await scenario('upstream 429 cools down only its credential and fallback continues', async () => {
    await request(`${mock}/__mock/reset`, { method: 'POST' }, 200);
    await message('dev-429', main.key, `e2e_cooldown_${randomUUID()}`);
    const report = await waitFor('cred_mock-429 cooldown', async () => {
      const current = await health();
      return current.credentials.find((item) => item.credentialId === 'cred_mock-429');
    });
    assert.ok(report.cooldownUntil > Date.now());
    const before = (await stats()).byKey['Bearer mock:rate_limit'] ?? 0;
    await message('dev-429', main.key, `e2e_cooldown_skip_${randomUUID()}`);
    const after = await stats();
    assert.equal(
      after.byKey['Bearer mock:rate_limit'] ?? 0,
      before,
      'cooldown credential was retried',
    );
    assert.ok((after.byKey['sk-mock'] ?? 0) >= 1, JSON.stringify(after.byKey));
  });

  await scenario('rate limit and budget reject in the Anthropic error format', async () => {
    const limited = await createKey('budget', {
      budgets: [{ period: 'daily', limitTokens: 1 }],
    });
    const id = `e2e_budget_${randomUUID()}`;
    await message('mock/small', limited.key, id);
    const budget = await message(
      'mock/small',
      limited.key,
      `e2e_budget_reject_${randomUUID()}`,
      429,
    );
    assert.match(budget.body.error.message, /budget exceeded/i);
    assert.equal(budget.body.type, 'error');
    assert.equal(budget.body.error.type, 'billing_error');
    assert.ok(budget.response.headers.get('retry-after'));
    const rateKey = await createKey('rate-limit', { rpm: 1 });
    await message('mock/small', rateKey.key, `e2e_rpm_first_${randomUUID()}`);
    const rate = await message('mock/small', rateKey.key, `e2e_rpm_${randomUUID()}`, 429);
    assert.equal(rate.body.error.type, 'rate_limit_error');
    assert.ok(rate.response.headers.get('retry-after'));
    assert.equal(rate.response.headers.get('x-ratelimit-remaining-requests'), '0');
  });

  await scenario('control-api outage keeps serving the last persisted config', async () => {
    await docker('control-api', ['stop', 'control-api']);
    stopped.add('control-api');
    await waitFor(
      'control-api sync failure',
      async () => !(await request(`${gateway}/readyz`)).body.controlApiSync,
    );
    const { body } = await message('mock/small', main.key, `e2e_config_outage_${randomUUID()}`);
    assert.match(body.content[0].text, /Hello from/);
    assert.equal(
      (await request(`${gateway}/readyz`, {}, 200)).body.configVersion,
      firstConfigVersion,
    );
    await docker('control-api', ['start', 'control-api']);
    stopped.delete('control-api');
    await waitFor(
      'control-api recovery',
      async () => (await request(`${gateway}/readyz`)).body.controlApiSync,
    );
  });

  await scenario(
    'Valkey outage spools usage and replay writes both records exactly once',
    async () => {
      const id = `e2e_valkey_${randomUUID()}`;
      await docker('valkey', ['stop', 'valkey']);
      stopped.add('valkey');
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      const { body } = await message('mock/small', main.key, id);
      assert.match(body.content[0].text, /Hello from/);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      const { stdout: files } = await docker('gateway', [
        'exec',
        '-T',
        'gateway',
        'sh',
        '-c',
        'ls /repo/.data/gateway/outbox/usage-*.ndjson 2>/dev/null',
      ]);
      assert.ok(files.trim(), 'usage was not persisted to the local outbox');
      assert.equal(await sql(`SELECT count(*) FROM request_log WHERE id='${id}'`), '0');
      await docker('valkey', ['start', 'valkey']);
      stopped.delete('valkey');
      await waitFor('Valkey readiness', async () => (await sql('SELECT 1')) === '1');
      await waitFor(
        'usage replay into request_log',
        async () => (await sql(`SELECT count(*) FROM request_log WHERE id='${id}'`)) === '1',
        45_000,
      );
      assert.equal(await sql(`SELECT count(*) FROM usage_ledger WHERE request_id='${id}'`), '1');
      assert.equal((await request(`${gateway}/readyz`, {}, 200)).body.status, 'ok');
    },
  );

  console.log(JSON.stringify({ status: 'passed', scenarios: results }, null, 2));
} catch (error) {
  console.error('FAIL', error);
  console.error(JSON.stringify({ status: 'failed', scenarios: results }, null, 2));
  process.exitCode = 1;
} finally {
  for (const service of stopped) {
    try {
      await docker(service, ['start', service]);
    } catch (error) {
      console.error(`Could not restore ${service}:`, error);
      process.exitCode = 1;
    }
  }
  if (token) {
    for (const id of keys) {
      try {
        await callAdmin('POST', `orgs/org_dev/keys/${id}/revoke`);
      } catch (error) {
        console.error(`Could not revoke temporary key ${id}:`, error);
        process.exitCode = 1;
      }
    }
  }
  console.log('Cleanup: temporary API keys revoked; interrupted services restarted.');
}
