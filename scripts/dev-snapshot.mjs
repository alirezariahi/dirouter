// snapshot آزمایشی برای گیت‌وی (تا آماده شدن seed و انتشار snapshot در control-api، کارت‌های ۳.۹ و ۳.۱۱).
// provider ساختگی، یک combo و یک کلید dev می‌سازد؛ کلید را روی stderr چاپ می‌کند.
// استفاده: node scripts/dev-snapshot.mjs <خروجی> [آدرس mock]   (MASTER_KEY و KEY_PEPPER از env)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { encrypt, hashApiKey, parseKeyring } from '../packages/shared/dist/index.js';

const [out = '.data/gateway/snapshot.json', mockUrl = 'http://mock-provider:8090/v1'] =
  process.argv.slice(2);
const { MASTER_KEY, KEY_PEPPER, DEV_API_KEY = 'dr-dev-local-0000000000000000' } = process.env;
if (!MASTER_KEY || !KEY_PEPPER) {
  process.stderr.write(
    'MASTER_KEY و KEY_PEPPER لازم‌اند / MASTER_KEY and KEY_PEPPER are required\n',
  );
  process.exit(1);
}
const keyring = parseKeyring(MASTER_KEY);
const cred = (id, secret) => ({
  id,
  name: id,
  secret: encrypt(keyring, secret, id),
  enabled: true,
});
const provider = (id, secret, extra = {}) => ({
  id,
  organizationId: 'org_dev',
  slug: id,
  type: 'openai-compatible',
  name: id,
  baseUrl: mockUrl,
  enabled: true,
  options: {},
  credentials: [cred(`${id}-key`, secret)],
  ...extra,
});
const model = (id, providerId, upstream) => ({
  id,
  organizationId: 'org_dev',
  slug: id,
  providerId,
  upstreamModel: upstream,
  enabled: true,
  contextWindow: 32_000,
  pricing: { inputPerMTok: '0.10', outputPerMTok: '0.20' },
  capabilities: { tools: true },
});
const snapshot = {
  schemaVersion: 1,
  version: Math.floor(Date.now() / 1000),
  generatedAt: new Date().toISOString(),
  providers: [
    provider('mock', 'sk-mock'),
    provider('mock-down', 'mock:status=503'),
    // stream ده‌دقیقه‌ای: ۶۰۰ chunk با فاصلهٔ یک ثانیه (تست Traefik، کارت ۲.۳)
    provider('mock-long', 'mock:chunks=600,chunk_delay=1000,text=' + 'x'.repeat(600), {
      timeouts: { totalMs: 900_000, idleMs: 30_000 },
    }),
  ],
  models: [
    model('mock/small', 'mock', 'mock-small'),
    model('mock/down', 'mock-down', 'mock-small'),
    model('mock/long', 'mock-long', 'mock-small'),
  ],
  combos: [
    {
      id: 'cmb_dev',
      organizationId: 'org_dev',
      slug: 'dev',
      strategy: 'priority',
      targets: [
        { modelId: 'mock/down', order: 0 },
        { modelId: 'mock/small', order: 1 },
      ],
    },
  ],
  aliases: [
    { organizationId: 'org_dev', slug: 'gpt-4.1', target: { kind: 'combo', comboId: 'cmb_dev' } },
  ],
  virtualKeys: [
    {
      id: 'vk_dev',
      hash: hashApiKey(DEV_API_KEY, KEY_PEPPER),
      prefix: DEV_API_KEY.slice(0, 10),
      organizationId: 'org_dev',
      teamId: null,
      projectId: 'prj_dev',
      enabled: true,
      expiresAt: null,
    },
  ],
  settings: { defaultTimeouts: { totalMs: 900_000 } },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snapshot));
process.stderr.write(`snapshot → ${out}\nکلید dev / dev key: ${DEV_API_KEY}\n`);
