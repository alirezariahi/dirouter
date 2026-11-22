/* eslint-disable no-console */
/**
 * HA application-tier check (card 17.3). Runs inside the edge network of a stack started with
 * compose.ha.yaml and talks to every gateway replica directly (no load balancer), so it shows
 * what each replica does on its own.
 *
 *   docker run --rm --network <project>_edge -v "$PWD":/repo:ro dirouter/dev:local \
 *     node /repo/scripts/verify/ha-app.mjs basic      # replicas, config propagation, shared limit
 *   ... node /repo/scripts/verify/ha-app.mjs load 30  # steady load for 30 s; stop a dependency
 *                                                     # meanwhile and read the status codes
 *
 * Needs the development seed data (dev key, mock models) in the database of that stack.
 */
import { resolve4 } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(
  readFileSync('/repo/.data/seed-admin.env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const KEY = 'dr-dev-local-0000000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phase = process.argv[2];
const ips = await resolve4('gateway');
const gw = (ip, path, init) =>
  fetch(`http://${ip}:8080${path}`, { signal: AbortSignal.timeout(8000), ...init });
const chat = (ip, key = KEY) =>
  gw(ip, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'mock/small', messages: [{ role: 'user', content: 'ha' }] }),
  });
const admin = async (method, path, body, token) => {
  const r = await fetch(`http://control-api:3000/api/v1/${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
};
const versions = async () =>
  Promise.all(ips.map(async (ip) => (await (await gw(ip, '/readyz')).json()).configVersion));
const out = { phase, replicas: ips.length };

if (phase === 'basic') {
  const instances = new Set();
  for (const ip of ips) {
    const r = await chat(ip);
    out[`chat_${ip}`] = r.status;
    instances.add(r.headers.get('x-dirouter-instance'));
  }
  out.instances = instances.size;
  out.versions = await versions();
  const login = await admin('POST', 'auth/login', {
    email: env.SEED_ADMIN_EMAIL,
    password: env.SEED_ADMIN_PASSWORD,
  });
  const token = login.body.accessToken;
  out.login = login.status;
  // A config change must reach every gateway; then a rollback, timed across all replicas.
  const before = Math.max(...(await versions()));
  const models = (await admin('GET', 'orgs/org_dev/models', undefined, token)).body;
  const small = (models.items ?? models).find((m) => m.slug === 'mock/small');
  let t0 = Date.now();
  const alias = await admin(
    'POST',
    'orgs/org_dev/aliases',
    { slug: `ha-alias-${Date.now()}`, modelId: small.id },
    token,
  );
  out.aliasCreate = alias.status;
  while ((await versions()).some((v) => v <= before)) await sleep(20);
  out.changeAllReplicasMs = Date.now() - t0;
  t0 = Date.now();
  const rolled = await admin(
    'POST',
    `orgs/org_dev/config/versions/${before}/rollback`,
    { reason: 'ha drill' },
    token,
  );
  out.rollback = rolled.status;
  while ((await versions()).some((v) => v < rolled.body.version)) await sleep(20);
  out.rollbackAllReplicasMs = Date.now() - t0;
  out.versionsAfter = await versions();
  out.aliasGoneEverywhere = (
    await Promise.all(
      ips.map(
        async (ip) =>
          (
            await gw(ip, '/v1/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
              body: JSON.stringify({
                model: alias.body.slug,
                messages: [{ role: 'user', content: 'x' }],
              }),
            })
          ).status,
      ),
    )
  ).join(',');
  // A shared rate limit: one key limited to 6 requests per minute, hit across all replicas.
  const key = await admin(
    'POST',
    'orgs/org_dev/keys',
    { name: `ha-rpm-${Date.now()}`, projectId: 'prj_dev', rpm: 6 },
    token,
  );
  for (let i = 0; i < 100; i++) {
    if (
      (
        await Promise.all(
          ips.map(
            async (ip) =>
              (await gw(ip, '/v1/models', { headers: { authorization: `Bearer ${key.body.key}` } }))
                .status,
          ),
        )
      ).every((s) => s === 200)
    )
      break;
    await sleep(100);
  }
  const statuses = [];
  for (let i = 0; i < 18; i++)
    statuses.push((await chat(ips[i % ips.length], key.body.key)).status);
  out.rateLimited = {
    ok: statuses.filter((s) => s === 200).length,
    limited: statuses.filter((s) => s === 429).length,
  };
  await admin('POST', `orgs/org_dev/keys/${key.body.id}/revoke`, undefined, token);
}

if (phase === 'load') {
  // Steady load over every replica that resolves, for N seconds; a failing replica is reported per IP.
  const seconds = Number(process.argv[3] ?? 30);
  const per = {};
  const end = Date.now() + seconds * 1000;
  let i = 0;
  const all = [];
  while (Date.now() < end) {
    const ip = ips[i++ % ips.length];
    const started = Date.now();
    all.push(
      chat(ip)
        .then(
          (r) => r.status,
          () => 0,
        )
        .then((status) => {
          (per[ip] ??= {})[status] = (per[ip][status] ?? 0) + 1;
          return Date.now() - started;
        }),
    );
    await sleep(25);
  }
  const lat = (await Promise.all(all)).sort((a, b) => a - b);
  out.perReplica = per;
  out.p95ms = lat[Math.floor(lat.length * 0.95)];
  const totals = {};
  for (const v of Object.values(per))
    for (const [s, n] of Object.entries(v)) totals[s] = (totals[s] ?? 0) + n;
  out.totals = totals;
}
console.log(JSON.stringify(out));
