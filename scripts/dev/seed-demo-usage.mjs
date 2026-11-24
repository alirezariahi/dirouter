// Demo usage for the development dashboard: 30 days of hourly and daily rollups for the dev
// organization, so charts and reports have something to draw. Development only.
//
//   node scripts/dev/seed-demo-usage.mjs            # (re)create the demo rows
//   node scripts/dev/seed-demo-usage.mjs --clear    # remove them
//
// Every demo row has an api_key_id starting with `key_demo_`, which is how it is removed. The rollup
// tables get the usage and the usage ledger gets one matching entry per key and hour, so the cost
// page reconciles. The request log is not touched.
import { execFileSync } from 'node:child_process';

// The organization and the database container of the development compose stack.
const ORG = 'org_dev';
const POSTGRES = 'dirouter-postgres-1';
const DAYS = 30;
const psql = (sql) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      POSTGRES,
      'psql',
      '-U',
      'dirouter',
      '-d',
      'dirouter',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ],
    { input: sql, stdio: ['pipe', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );

const clear = `
  DELETE FROM usage_hourly WHERE organization_id = '${ORG}' AND api_key_id LIKE 'key_demo_%';
  DELETE FROM usage_daily WHERE organization_id = '${ORG}' AND api_key_id LIKE 'key_demo_%';
  DELETE FROM usage_ledger WHERE organization_id = '${ORG}' AND api_key_id LIKE 'key_demo_%';`;
if (process.argv.includes('--clear')) {
  psql(clear);
  process.stdout.write('demo usage removed\n');
  process.exit(0);
}

// Deterministic noise, so reruns draw the same picture.
let seed = 20261124;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// share: part of the traffic; in/out: tokens per request; price per million tokens; latency in ms.
const MODELS = [
  {
    slug: 'openai/gpt-4.1',
    provider: 'prv_demo_openai',
    share: 0.3,
    input: 1900,
    output: 420,
    pin: 2,
    pout: 8,
    latency: 1400,
  },
  {
    slug: 'anthropic/claude-sonnet-4-5',
    provider: 'prv_demo_anthropic',
    share: 0.24,
    input: 2600,
    output: 610,
    pin: 3,
    pout: 15,
    latency: 1900,
  },
  {
    slug: 'openai/gpt-4.1-mini',
    provider: 'prv_demo_openai',
    share: 0.2,
    input: 1200,
    output: 260,
    pin: 0.4,
    pout: 1.6,
    latency: 620,
  },
  {
    slug: 'google/gemini-2.5-flash',
    provider: 'prv_demo_google',
    share: 0.16,
    input: 1500,
    output: 300,
    pin: 0.3,
    pout: 2.5,
    latency: 540,
  },
  {
    slug: 'mistral/mistral-large',
    provider: 'prv_demo_mistral',
    share: 0.07,
    input: 1700,
    output: 380,
    pin: 2,
    pout: 6,
    latency: 1100,
  },
  {
    slug: 'openai/text-embedding-3-small',
    provider: 'prv_demo_openai',
    share: 0.03,
    input: 800,
    output: 0,
    pin: 0.02,
    pout: 0,
    latency: 90,
  },
];
const KEYS = [
  { id: 'key_demo_support-assistant', project: 'prj_demo_support', share: 0.38 },
  { id: 'key_demo_checkout-api', project: 'prj_demo_storefront', share: 0.27 },
  { id: 'key_demo_search-reranker', project: 'prj_demo_storefront', share: 0.17 },
  { id: 'key_demo_docs-chat', project: 'prj_demo_docs', share: 0.12 },
  { id: 'key_demo_internal-tools', project: 'prj_demo_internal', share: 0.06 },
];
// Upper bounds of the latency histogram buckets, as in the stats service.
const BOUNDS = [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];

const hourStart = new Date();
hourStart.setUTCMinutes(0, 0, 0);
const hourly = [];
const daily = new Map();
// Cost in units of 1e-8 USD, so the ledger adds up to exactly what the rollups hold.
const ledger = new Map();

for (let h = DAYS * 24 - 1; h >= 0; h--) {
  const at = new Date(hourStart.getTime() - h * 3_600_000);
  const hour = at.getUTCHours();
  const weekday = at.getUTCDay();
  // Working-hours curve, quieter weekends, slow growth over the month.
  const daytime =
    0.25 + 0.75 * Math.max(0, Math.sin(((hour - 5) / 24) * Math.PI * 2 - 0.3) * 0.5 + 0.5);
  const week = weekday === 5 || weekday === 6 ? 0.55 : 1;
  const growth = 0.7 + 0.3 * (1 - h / (DAYS * 24));
  const base = 950 * daytime * week * growth * (0.88 + rand() * 0.24);
  // One incident three days ago: a provider failing for two hours.
  const incident = h >= 70 && h <= 71;

  for (const model of MODELS) {
    for (const key of KEYS) {
      const requests = Math.round(base * model.share * key.share * (0.8 + rand() * 0.4));
      if (requests === 0) continue;
      const failing = incident && model.provider === 'prv_demo_anthropic';
      const errors = Math.min(
        requests,
        Math.round(requests * (failing ? 0.42 : 0.004 + rand() * 0.012)),
      );
      const ok = requests - errors;
      const input = Math.round(ok * model.input * (0.9 + rand() * 0.2));
      const output = Math.round(ok * model.output * (0.9 + rand() * 0.2));
      const cost = (input * model.pin + output * model.pout) / 1_000_000;
      const latency = model.latency * (failing ? 2.6 : 0.9 + rand() * 0.25);
      // Spread the requests over the histogram around the typical latency.
      const hist = BOUNDS.map(() => 0);
      // Most requests are faster than the mean; a tail is slower.
      const fast = BOUNDS.findIndex((b) => latency * 0.55 <= b);
      const mid = BOUNDS.findIndex((b) => latency <= b);
      const slow = Math.min(BOUNDS.length - 1, mid + 1);
      hist[fast] += Math.round(requests * 0.6);
      hist[mid] += Math.round(requests * 0.32);
      hist[slow] += requests - Math.round(requests * 0.6) - Math.round(requests * 0.32);
      const row = {
        project: key.project,
        key: key.id,
        model: model.slug,
        provider: model.provider,
        requests,
        errors,
        input,
        output,
        cost,
        latencySum: Math.round(requests * latency),
        ttftSum: Math.round(ok * latency * 0.28),
        ttftCount: ok,
        hist,
      };
      hourly.push({ bucket: at.toISOString(), ...row });
      const entryKey = `${at.toISOString()}|${key.id}`;
      const entry = ledger.get(entryKey) ?? { at, key, units: 0, tokens: 0 };
      entry.units += Math.round(Number(cost.toFixed(8)) * 1e8);
      entry.tokens += input + output;
      ledger.set(entryKey, entry);
      const dayKey = `${at.toISOString().slice(0, 10)}|${key.id}|${model.slug}`;
      const d = daily.get(dayKey);
      if (!d) daily.set(dayKey, { bucket: at.toISOString().slice(0, 10), ...row, hist: [...hist] });
      else {
        for (const f of [
          'requests',
          'errors',
          'input',
          'output',
          'cost',
          'latencySum',
          'ttftSum',
          'ttftCount',
        ])
          d[f] += row[f];
        d.hist = d.hist.map((v, i) => v + hist[i]);
      }
    }
  }
}

const values = (rows) =>
  rows
    .map(
      (r) =>
        `('${r.bucket}','${ORG}','${r.project}','${r.key}','${r.model}','${r.provider}',${r.requests},${r.errors},${r.input},${r.output},${r.cost.toFixed(8)},${r.cost.toFixed(8)},${r.latencySum},${r.ttftSum},${r.ttftCount},ARRAY[${r.hist.join(',')}])`,
    )
    .join(',\n');
const columns =
  '(bucket, organization_id, project_id, api_key_id, model_slug, provider_id, requests, errors, input_tokens, output_tokens, cost_usd, charge_usd, latency_ms_sum, ttft_ms_sum, ttft_count, latency_hist)';

psql(`BEGIN;${clear}
INSERT INTO usage_hourly ${columns} VALUES
${values(hourly)};
INSERT INTO usage_daily ${columns} VALUES
${values([...daily.values()])};
INSERT INTO usage_ledger (id, request_id, organization_id, project_id, api_key_id, cost_usd, tokens, occurred_at) VALUES
${[...ledger.values()]
  .map((e, i) => {
    const id = `demo_${String(i).padStart(6, '0')}`;
    const when = new Date(e.at.getTime() + 1000).toISOString();
    return `('led_${id}','req_${id}','${ORG}','${e.key.project}','${e.key.id}',${(e.units / 1e8).toFixed(8)},${e.tokens},'${when}')`;
  })
  .join(',\n')};
COMMIT;`);
process.stdout.write(
  `demo usage: ${hourly.length} hourly and ${daily.size} daily rows, ${ledger.size} ledger entries for ${ORG}\n`,
);
