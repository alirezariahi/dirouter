// overhead گیت‌وی نسبت به فراخوانی مستقیم mock (کارت ۴.۱).
// استفاده: pnpm build && node scripts/bench/overhead.mjs [تعداد=3000]
// mock-provider و گیت‌وی (از dist، NODE_ENV=production، LOG_LEVEL=warn) را جدا اجرا می‌کند،
// هر دو مسیر را با keep-alive و به‌صورت ترتیبی می‌زند و p50/p95/p99 را چاپ می‌کند.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const N = Number(process.argv[2] ?? 3000);
const WARMUP = 300;
const MOCK_PORT = 18090;
const GW_PORT = 18787;
const env = {
  ...process.env,
  NODE_ENV: 'production',
  LOG_LEVEL: 'warn',
  MASTER_KEY: randomBytes(32).toString('base64'),
  KEY_PEPPER: randomBytes(32).toString('hex'),
};
const dataDir = mkdtempSync(join(tmpdir(), 'dirouter-bench-'));

const run = (cmd, args, extra) =>
  spawn(cmd, args, { env: { ...env, ...extra }, stdio: ['ignore', 'inherit', 'inherit'] });

const snap = run('node', [
  'scripts/dev-snapshot.mjs',
  join(dataDir, 'snapshot.json'),
  `http://127.0.0.1:${MOCK_PORT}/v1`,
]);
await new Promise((r) => snap.on('exit', r));
const children = [
  run('node', ['apps/mock-provider/dist/main.js'], { PORT: String(MOCK_PORT) }),
  run('node', ['apps/gateway/dist/main.js'], { PORT: String(GW_PORT), DATA_DIR: dataDir }),
];
const stop = () => children.forEach((c) => c.kill('SIGKILL'));
process.on('exit', stop);

async function waitReady(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // هنوز بالا نیامده
    }
    await sleep(100);
  }
  throw new Error(`not ready: ${url}`);
}
await waitReady(`http://127.0.0.1:${MOCK_PORT}/healthz`);
await waitReady(`http://127.0.0.1:${GW_PORT}/readyz`);

const body = JSON.stringify({
  model: 'mock/small',
  messages: [{ role: 'user', content: 'Hello, how are you today?' }],
});
async function measure(port, headers) {
  // fetch سراسری Node (undici) اتصال keep-alive را بین درخواست‌های ترتیبی نگه می‌دارد.
  const times = [];
  for (let i = 0; i < WARMUP + N; i++) {
    const t = process.hrtime.bigint();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    await res.text();
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (i >= WARMUP) times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.floor((times.length - 1) * p)];
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

const direct = await measure(MOCK_PORT, { authorization: 'Bearer sk-mock' });
const viaGateway = await measure(GW_PORT, {
  authorization: 'Bearer dr-dev-local-0000000000000000',
});
const fmt = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, `${v.toFixed(3)}ms`]));
process.stdout.write(
  `${JSON.stringify({ requests: N, direct: fmt(direct), gateway: fmt(viaGateway) })}\n`,
);
process.stdout.write(
  `overhead p50=${(viaGateway.p50 - direct.p50).toFixed(3)}ms p95=${(viaGateway.p95 - direct.p95).toFixed(3)}ms p99=${(viaGateway.p99 - direct.p99).toFixed(3)}ms\n`,
);
stop();
process.exit(0);
