#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Chaos test (card 18.1): keeps a steady request load on the gateway while one dependency at a
 * time is taken away, and measures what happens to the requests sent while the fault is active.
 *
 * Pass criteria per scenario, both measured over the fault window only (from the moment the fault
 * is injected until the dependency is back; warm-up and recovery traffic are reported separately
 * and never dilute the numbers):
 *   1. failed requests (5xx or connection error) <= CHAOS_MAX_FAILURE_RATIO (default 1%);
 *   2. successful requests (2xx) >= the scenario's minimum, CHAOS_MIN_SUCCESS_RATIO by default
 *      (99%). Without it a gateway that answers every request with 401 or 429 would pass.
 *
 * Before any fault is injected a preflight request must succeed for every model the scenarios
 * use; an unhealthy baseline (for example 401 because the stack was not seeded) aborts the run.
 *
 *   make up && make migrate && make seed      # the development stack with seed data
 *   node scripts/chaos/run.mjs                # all scenarios
 *   node scripts/chaos/run.mjs valkey postgres
 *
 * Environment:
 *   CHAOS_RPS (20), CHAOS_FAULT_SECONDS (15), CHAOS_MAX_FAILURE_RATIO (0.01),
 *   CHAOS_MIN_SUCCESS_RATIO (0.99), CHAOS_COMPOSE ("-f compose.yaml -f compose.dev.yaml"),
 *   E2E_GATEWAY_URL, E2E_ADMIN_URL.
 *
 * Results are printed and written to .verify/chaos-<timestamp>.json and docs-ready Markdown to
 * .verify/chaos-<timestamp>.md. Services stopped by the script are always started again, also
 * when the run fails or is interrupted with Ctrl-C (SIGINT) or SIGTERM; the exit code is then
 * non-zero.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compose = [
  'compose',
  ...(process.env.CHAOS_COMPOSE ?? '-f compose.yaml -f compose.dev.yaml')
    .split(/\s+/)
    .filter(Boolean),
];
const gateway = process.env.E2E_GATEWAY_URL ?? 'http://api.localhost';
const admin = process.env.E2E_ADMIN_URL ?? 'http://admin.localhost';
const RPS = Number(process.env.CHAOS_RPS ?? 20);
const FAULT_SECONDS = Number(process.env.CHAOS_FAULT_SECONDS ?? 15);
const MAX_RATIO = Number(process.env.CHAOS_MAX_FAILURE_RATIO ?? 0.01);
const MIN_SUCCESS = Number(process.env.CHAOS_MIN_SUCCESS_RATIO ?? 0.99);
const WARMUP_MS = 3_000;
const RECOVERY_MS = 5_000;
const env = {
  ...process.env,
  GRAFANA_ADMIN_PASSWORD: process.env.GRAFANA_ADMIN_PASSWORD ?? 'chaos-not-used',
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Undo actions of the faults that are active right now: name -> function that removes the fault. */
const pendingRecoveries = new Map();
let token;
let keyId;
/** Set by the signal handlers; no new fault is injected once it is true. */
let interrupted = false;

async function docker(args, options = {}) {
  return exec('docker', [...compose, ...args], {
    cwd: root,
    env,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}
const stop = (service) => docker(['stop', service]);
const start = (service) => docker(['start', service]);
async function json(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), ...options });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}
async function waitFor(description, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${description}: ${String(last)}`);
}
const gatewayReady = () =>
  waitFor('gateway ready', async () => (await json(`${gateway}/readyz`)).response.status === 200);

/** Counts the samples whose request started in [from, to). */
function summarize(samples, from, to) {
  const counts = {
    total: 0,
    ok: 0,
    clientErrors: 0,
    serverErrors: 0,
    networkErrors: 0,
    statuses: {},
  };
  const latencies = [];
  for (const sample of samples) {
    if (sample.started < from || sample.started >= to) continue;
    counts.total += 1;
    if (sample.status === null) {
      counts.networkErrors += 1;
      continue;
    }
    counts.statuses[sample.status] = (counts.statuses[sample.status] ?? 0) + 1;
    if (sample.status >= 500) counts.serverErrors += 1;
    else if (sample.status >= 400) counts.clientErrors += 1;
    else if (sample.status >= 200 && sample.status < 300) counts.ok += 1;
    latencies.push(sample.ms);
  }
  latencies.sort((x, y) => x - y);
  const failed = counts.serverErrors + counts.networkErrors;
  return {
    ...counts,
    failed,
    failureRatio: counts.total ? failed / counts.total : 0,
    // No request at all in a window is not a success.
    successRatio: counts.total ? counts.ok / counts.total : 0,
    p95Ms: latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
      : null,
  };
}

function chatRequest(key, model, timeoutMs = 20_000) {
  return fetch(`${gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: `chaos ${randomUUID()}` }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Open-loop load: a request starts every 1000/RPS ms whether or not earlier ones have finished.
 * Every request is kept as a sample with its start time, so each phase is measured on its own.
 */
function startLoad(key, model) {
  const samples = [];
  const inFlight = new Set();
  let running = true;
  const fire = () => {
    const sample = { started: Date.now(), status: null, ms: null };
    samples.push(sample);
    const pending = chatRequest(key, model)
      .then(async (response) => {
        await response.arrayBuffer();
        sample.status = response.status;
        sample.ms = Date.now() - sample.started;
      })
      .catch(() => {
        // Connection error, timeout or a body that broke off: the sample keeps status null.
        sample.status = null;
      })
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  };
  const timer = setInterval(() => running && fire(), Math.max(1, Math.round(1000 / RPS)));
  return async () => {
    running = false;
    clearInterval(timer);
    await Promise.allSettled([...inFlight]);
    return samples;
  };
}

/**
 * Runs load for a warm-up, the fault window and a recovery window. The pass criteria use the
 * fault window only: from just before the fault is injected until `recover` has returned.
 */
async function underFault(name, key, model, inject, recover) {
  const finish = startLoad(key, model);
  const loadStarted = Date.now();
  await sleep(WARMUP_MS);
  const faultStarted = Date.now();
  let note;
  // An interrupted run is being cleaned up: do not break anything else.
  if (interrupted) throw new Error('interrupted');
  // Registered before the fault exists, so an interrupt in the middle of `inject` is undone too.
  if (recover) pendingRecoveries.set(name, recover);
  try {
    note = await inject();
    await sleep(FAULT_SECONDS * 1_000);
  } finally {
    if (recover) {
      await recover();
      pendingRecoveries.delete(name);
    }
  }
  const faultEnded = Date.now();
  await sleep(RECOVERY_MS);
  const samples = await finish();
  return {
    ...summarize(samples, faultStarted, faultEnded),
    faultMs: faultEnded - faultStarted,
    warmup: summarize(samples, loadStarted, faultStarted),
    recovery: summarize(samples, faultEnded, Number.POSITIVE_INFINITY),
    ...(typeof note === 'string' ? { note } : {}),
  };
}

/**
 * `minSuccess` is the lowest acceptable share of 2xx answers during the fault window. Every
 * scenario here is one the gateway must ride out (fail-open limiter, last snapshot, fallback), so
 * all of them use the default; set a lower value on a scenario that is allowed to shed load.
 */
const SCENARIOS = {
  baseline: {
    title: 'No fault (baseline)',
    run: (key) => underFault('baseline', key, 'mock/small', () => undefined),
  },
  'provider-down': {
    title: 'Primary provider returns 503 (combo falls back)',
    // The seeded `dev` combo tries mock/down first, so every request exercises fallback.
    run: (key) => underFault('provider-down', key, 'dev', () => undefined),
    model: 'dev',
  },
  'control-api': {
    title: 'control-api stopped',
    run: (key) =>
      underFault(
        'control-api',
        key,
        'mock/small',
        () => stop('control-api'),
        () => start('control-api'),
      ),
  },
  valkey: {
    title: 'Valkey stopped (limiter, usage queue, health sync)',
    run: (key) =>
      underFault(
        'valkey',
        key,
        'mock/small',
        () => stop('valkey'),
        () => start('valkey'),
      ),
  },
  postgres: {
    title: 'PostgreSQL stopped',
    run: (key) =>
      underFault(
        'postgres',
        key,
        'mock/small',
        () => stop('postgres'),
        () => start('postgres'),
      ),
  },
  worker: {
    title: 'worker stopped (usage events queue up)',
    run: (key) =>
      underFault(
        'worker',
        key,
        'mock/small',
        () => stop('worker'),
        () => start('worker'),
      ),
  },
  'gateway-replica': {
    title: 'One gateway replica killed',
    run: async (key) => {
      const { stdout } = await docker(['ps', '-q', 'gateway']);
      const ids = stdout.split('\n').filter(Boolean);
      if (ids.length < 2)
        return {
          skipped: `needs at least 2 gateway replicas, found ${String(ids.length)} (use the prod or HA compose files)`,
        };
      const victim = ids[0];
      return underFault(
        'gateway-replica',
        key,
        'mock/small',
        async () => {
          await exec('docker', ['kill', '--signal', 'SIGKILL', victim]);
          return `killed container ${victim.slice(0, 12)} of ${String(ids.length)}`;
        },
        async () => {
          // Keep the replica count: a plain `up` would scale the service back to its default and
          // remove the surviving replicas in the middle of the measurement.
          await docker([
            'up',
            '-d',
            '--no-deps',
            '--no-recreate',
            '--scale',
            `gateway=${String(ids.length)}`,
            'gateway',
          ]);
        },
      );
    },
  },
};

const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
const unknown = selected.filter((name) => !SCENARIOS[name]);
if (unknown.length) {
  console.error(
    `unknown scenario(s): ${unknown.join(', ')}. Available: ${Object.keys(SCENARIOS).join(', ')}`,
  );
  process.exit(2);
}

const pct = (ratio) => `${(ratio * 100).toFixed(2)}%`;
const statusList = (r) =>
  [
    ...Object.entries(r.statuses).map(([status, count]) => `${status}×${String(count)}`),
    ...(r.networkErrors ? [`network×${String(r.networkErrors)}`] : []),
  ].join(', ') || '—';

/** Sends one request and explains a non-2xx answer; used before any fault is injected. */
async function preflight(key, model) {
  let response;
  try {
    response = await chatRequest(key, model, 30_000);
  } catch (error) {
    throw new Error(
      `preflight failed: no answer from ${gateway} for model "${model}" (${String(error)}). The baseline is not healthy; no fault was injected.`,
      { cause: error },
    );
  }
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' The key was not accepted: is the stack seeded (`make seed`) and did the gateway load the snapshot?'
        : response.status === 404
          ? ' The model is unknown: is the stack seeded (`make seed`)?'
          : '';
    throw new Error(
      `preflight failed: model "${model}" answered ${String(response.status)} before any fault was injected: ${text.slice(0, 300)}.${hint}`,
    );
  }
}

let cleaning;
/** Removes every active fault and revokes the temporary key. Safe to call more than once. */
function cleanup() {
  cleaning ??= (async () => {
    let ok = true;
    for (const [name, recover] of [...pendingRecoveries]) {
      try {
        await recover();
        pendingRecoveries.delete(name);
        console.error(`restored after the "${name}" fault`);
      } catch (error) {
        ok = false;
        console.error(`could not restore after the "${name}" fault; restore it by hand:`, error);
      }
    }
    if (token && keyId) {
      await json(`${admin}/api/v1/orgs/org_dev/keys/${keyId}/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    return ok;
  })();
  return cleaning;
}

// Ctrl-C in the middle of a fault must not leave PostgreSQL or Valkey stopped.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.on(signal, () => {
    if (interrupted) {
      console.error('still restoring the stopped services, please wait ...');
      return;
    }
    interrupted = true;
    console.error(`\n${signal} received: restoring the stopped services before exiting ...`);
    void cleanup().finally(() => process.exit(code));
  });
}

const results = [];
try {
  await gatewayReady();
  const credentials = Object.fromEntries(
    (await readFile(resolve(root, '.data/seed-admin.env'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  const login = await json(`${admin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: credentials.SEED_ADMIN_EMAIL,
      password: credentials.SEED_ADMIN_PASSWORD,
    }),
  });
  if (!login.body?.accessToken) throw new Error('login failed; run `make seed` first');
  token = login.body.accessToken;
  const before = (await json(`${gateway}/readyz`)).body.configVersion;
  const created = await json(`${admin}/api/v1/orgs/org_dev/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: `chaos-${randomUUID().slice(0, 8)}`,
      projectId: 'prj_dev',
      allowedModels: ['mock/small', 'dev'],
    }),
  });
  if (!created.body?.key)
    throw new Error(`could not create a key: ${JSON.stringify(created.body)}`);
  keyId = created.body.id;
  await waitFor(
    'snapshot with the new key',
    async () => (await json(`${gateway}/readyz`)).body.configVersion > before,
  );

  // The baseline must be healthy before anything is broken on purpose.
  const models = new Set(selected.map((name) => SCENARIOS[name].model ?? 'mock/small'));
  for (const model of models) await preflight(created.body.key, model);
  console.log(`preflight ok (${[...models].join(', ')})`);

  for (const name of selected) {
    const scenario = SCENARIOS[name];
    if (interrupted) break;
    process.stdout.write(`${scenario.title} ... `);
    await gatewayReady();
    await preflight(created.body.key, scenario.model ?? 'mock/small');
    const measured = await scenario.run(created.body.key);
    if (measured.skipped) {
      results.push({ name, title: scenario.title, passed: null, ...measured });
      console.log(`SKIPPED (${measured.skipped})`);
    } else {
      const minSuccess = scenario.minSuccess ?? MIN_SUCCESS;
      const failures = [];
      if (measured.total === 0) failures.push('no request was sent during the fault window');
      if (measured.failureRatio > MAX_RATIO)
        failures.push(`5xx + network ${pct(measured.failureRatio)} > ${pct(MAX_RATIO)}`);
      if (measured.successRatio < minSuccess)
        failures.push(`2xx ${pct(measured.successRatio)} < ${pct(minSuccess)}`);
      const passed = failures.length === 0;
      results.push({ name, title: scenario.title, passed, minSuccess, failures, ...measured });
      console.log(
        `${passed ? 'PASS' : 'FAIL'} fault window: ${String(measured.failed)}/${String(measured.total)} failed (${pct(measured.failureRatio)}, limit ${pct(MAX_RATIO)}), ` +
          `${String(measured.ok)}/${String(measured.total)} succeeded (${pct(measured.successRatio)}, minimum ${pct(minSuccess)}), p95 ${String(measured.p95Ms)} ms` +
          `; recovery: ${String(measured.recovery.failed)}/${String(measured.recovery.total)} failed, ${pct(measured.recovery.successRatio)} succeeded` +
          (passed ? '' : ` [${failures.join('; ')}] statuses: ${statusList(measured)}`),
      );
      if (measured.recovery.total && measured.recovery.successRatio < minSuccess)
        console.log(
          `  warning: only ${pct(measured.recovery.successRatio)} succeeded after the dependency came back (${statusList(measured.recovery)}); a client may not have reconnected`,
        );
    }
    // Let the stack settle (breakers, queue replay) before the next fault.
    await sleep(5_000);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (!(await cleanup())) process.exitCode = 1;
}

if (results.length) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const outDir = resolve(root, '.verify');
  await mkdir(outDir, { recursive: true });
  const meta = {
    date: new Date().toISOString(),
    rps: RPS,
    faultSeconds: FAULT_SECONDS,
    maxFailureRatio: MAX_RATIO,
    minSuccessRatio: MIN_SUCCESS,
    gateway,
  };
  await writeFile(
    resolve(outDir, `chaos-${stamp}.json`),
    JSON.stringify({ meta, results }, null, 2),
  );
  const rows = results.map((r) =>
    r.skipped
      ? `| ${r.title} | skipped | — | — | — | — | ${r.skipped} | — |`
      : `| ${r.title} | ${r.passed ? 'pass' : '**fail**'} | ${String(r.total)} | ${String(r.failed)} (${pct(r.failureRatio)}) | ${String(r.ok)} (${pct(r.successRatio)}) | ${String(r.p95Ms)} | ${statusList(r)} | ${String(r.recovery.failed)}/${String(r.recovery.total)} failed, ${pct(r.recovery.successRatio)} 2xx |`,
  );
  const markdown = [
    `Run: ${meta.date} · ${String(RPS)} req/s · fault window ${String(FAULT_SECONDS)} s · limits: 5xx + network ≤ ${pct(MAX_RATIO)}, 2xx ≥ ${pct(MIN_SUCCESS)} (both over the fault window only)`,
    '',
    '| Scenario | Result | Requests in fault window | Failed (5xx + network) | Succeeded (2xx) | p95 ms | Status codes | Recovery phase |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  await writeFile(resolve(outDir, `chaos-${stamp}.md`), markdown);
  console.log(`\n${markdown}`);
  if (results.some((r) => r.passed === false)) process.exitCode = 1;
}
