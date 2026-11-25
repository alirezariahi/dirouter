#!/usr/bin/env node
/* eslint-disable no-console */
// Live fallback demo: two mock providers behind the gateway, the primary is killed mid-run.
// Every request keeps answering 200; the gateway moves to the backup (an Anthropic-format API)
// without the client changing anything. No database, Valkey or Docker: the gateway reads a
// snapshot from disk, as in scripts/bench.
//
// Usage (after `pnpm build`):  node scripts/demo/fallback.mjs [--record timeline.json]
// The recording feeds scripts/demo/render-svg.mjs, which draws assets/demo-fallback.svg.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(
  process.env.DIROUTER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../..'),
);
const { encrypt, generateKey, hashApiKey, parseKeyring } = await import(
  join(ROOT, 'packages/shared/dist/index.js')
);

const PRIMARY_PORT = 18091;
const BACKUP_PORT = 18092;
const GATEWAY_PORT = 18080;
const REQUESTS = 14;
const KILL_AFTER = 5;
const GAP_MS = 450;
const API_KEY = 'dr-demo-0000000000000000000000';
const recordPath = process.argv.includes('--record')
  ? resolve(process.argv[process.argv.indexOf('--record') + 1])
  : null;

const MASTER_KEY = generateKey();
const KEY_PEPPER = 'demo-pepper-'.padEnd(40, 'x');
const keyring = parseKeyring(MASTER_KEY);
const org = 'org_demo';

const provider = (id, type, baseUrl) => ({
  id,
  organizationId: org,
  slug: id,
  type,
  name: id,
  baseUrl,
  enabled: true,
  options: {},
  credentials: [
    {
      id: `${id}-key`,
      name: `${id}-key`,
      secret: encrypt(keyring, 'sk-mock', `${id}-key`),
      enabled: true,
    },
  ],
});
const model = (id, providerId, upstream) => ({
  id,
  organizationId: org,
  slug: id,
  providerId,
  upstreamModel: upstream,
  enabled: true,
  contextWindow: 200_000,
  pricing: { inputPerMTok: '0.10', outputPerMTok: '0.20' },
  capabilities: { tools: true },
});

const snapshot = {
  schemaVersion: 1,
  version: 1,
  generatedAt: new Date().toISOString(),
  providers: [
    provider('openai', 'openai-compatible', `http://127.0.0.1:${PRIMARY_PORT}/v1`),
    provider('anthropic', 'anthropic', `http://127.0.0.1:${BACKUP_PORT}`),
  ],
  models: [
    model('openai/gpt-4.1', 'openai', 'gpt-4.1'),
    model('anthropic/claude', 'anthropic', 'claude-sonnet'),
  ],
  combos: [
    {
      id: 'cmb_chat',
      organizationId: org,
      slug: 'chat',
      strategy: 'priority',
      targets: [
        { modelId: 'openai/gpt-4.1', order: 0 },
        { modelId: 'anthropic/claude', order: 1 },
      ],
    },
  ],
  aliases: [{ organizationId: org, slug: 'chat', target: { kind: 'combo', comboId: 'cmb_chat' } }],
  virtualKeys: [
    {
      id: 'vk_demo',
      hash: hashApiKey(API_KEY, KEY_PEPPER),
      prefix: API_KEY.slice(0, 10),
      organizationId: org,
      teamId: null,
      projectId: 'prj_demo',
      enabled: true,
      expiresAt: null,
    },
  ],
  settings: { defaultTimeouts: { totalMs: 30_000 } },
};

const data = mkdtempSync(join(tmpdir(), 'dirouter-demo-'));
writeFileSync(join(data, 'snapshot.json'), JSON.stringify(snapshot));

const quiet = { LOG_LEVEL: 'silent', SHUTDOWN_DRAIN_MS: '0', SHUTDOWN_READY_DELAY_MS: '0' };
const env = { ...process.env, ...quiet, MASTER_KEY, KEY_PEPPER };
const start = (app, port, extra = {}) =>
  spawn('node', [join(ROOT, `apps/${app}/dist/main.js`)], {
    cwd: ROOT,
    env: { ...env, PORT: String(port), ...extra },
    stdio: 'ignore',
  });
const children = [
  start('mock-provider', PRIMARY_PORT),
  start('mock-provider', BACKUP_PORT),
  start('gateway', GATEWAY_PORT, { DATA_DIR: data }),
];
const [primary] = children;
const cleanup = () => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet; retry
    }
    await sleep(100);
  }
  throw new Error(`not ready: ${url}`);
}
await waitReady(`http://127.0.0.1:${PRIMARY_PORT}/healthz`);
await waitReady(`http://127.0.0.1:${BACKUP_PORT}/healthz`);
await waitReady(`http://127.0.0.1:${GATEWAY_PORT}/readyz`);

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const timeline = [];
let answered = 0;
let lastAttempts = 1;
let notedSkip = false;
const t0 = Date.now();
const say = (kind, text, colored = text) => {
  timeline.push({ at: Date.now() - t0, kind, text });
  console.log(colored);
};

say('cmd', `$ POST /v1/chat/completions {"model":"chat"}   × ${REQUESTS}, one every ${GAP_MS} ms`);
say('note', '  route "chat":  1) openai/gpt-4.1  →  2) anthropic/claude (fallback)');
say('blank', '');
for (let i = 1; i <= REQUESTS; i++) {
  if (i === KILL_AFTER + 1) {
    primary.kill('SIGKILL');
    say(
      'alert',
      '  ✖ primary provider "openai" is down (process killed)',
      paint('1;31', '  ✖ primary provider "openai" is down (process killed)'),
    );
  }
  const begin = performance.now();
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'Hello' }] }),
  });
  await res.arrayBuffer();
  const ms = Math.round(performance.now() - begin);
  const who = res.headers.get('x-dirouter-provider') ?? '-';
  const attempts = res.headers.get('x-dirouter-attempts') ?? '1';
  const line = `  #${String(i).padStart(2, '0')}  HTTP ${res.status}  provider=${who.padEnd(9)}  attempts=${attempts}  ${String(ms).padStart(3)} ms`;
  const ok = res.status === 200;
  if (ok) answered++;
  say(
    ok ? (who === 'openai' ? 'ok' : 'fallback') : 'error',
    line,
    paint(ok ? (who === 'openai' ? '32' : '33') : '31', line),
  );
  if (ok && who !== 'openai' && lastAttempts > 1 && attempts === '1' && !notedSkip) {
    notedSkip = true;
    const note = '  ↳ primary marked unhealthy: skipped, no more retries against it';
    say('note', note, paint('2', note));
  }
  lastAttempts = Number(attempts);
  await sleep(GAP_MS);
}
say('blank', '');
const summary =
  answered === REQUESTS
    ? `  ${answered}/${REQUESTS} answered — the client never saw the outage.`
    : `  ${answered}/${REQUESTS} answered.`;
say('done', summary, paint(answered === REQUESTS ? '1;32' : '1;31', summary));

if (recordPath) writeFileSync(recordPath, JSON.stringify(timeline, null, 2));
process.exit(0);
