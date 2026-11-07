// snapshot آزمایشی برای گیت‌وی (تا آماده شدن seed و انتشار snapshot در control-api، کارت‌های ۳.۹ و ۳.۱۱).
// provider ساختگی، یک combo و یک کلید dev می‌سازد؛ کلید را روی stderr چاپ می‌کند.
// استفاده: node scripts/dev-snapshot.mjs <خروجی> [آدرس mock]   (MASTER_KEY و KEY_PEPPER از env)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { encrypt, hashApiKey, parseKeyring } from '../packages/shared/dist/index.js';

const [out = '.data/gateway/snapshot.json', mockUrl = 'http://mock-provider:8090/v1'] =
  process.argv.slice(2);
const { MASTER_KEY, KEY_PEPPER, DEV_API_KEY = 'dr-dev-local-0000000000000000' } = process.env;
// کلیدهای کمکی برای تست احراز هویت در dev (کارت ۴.۳): محدود به یک مدل، و منقضی.
const LIMITED_API_KEY = 'dr-dev-limited-000000000000';
const EXPIRED_API_KEY = 'dr-dev-expired-000000000000';
const IP_API_KEY = 'dr-dev-ipallow-000000000000';
const mockRoot = mockUrl.replace(/\/v1\/?$/, '');
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
    // سناریوهای خطا برای تست طبقه‌بندی و fallback (کارت‌های ۵.۱ و ۵.۲)
    provider('mock-bad', 'mock:status=400'),
    provider('mock-429', 'mock:rate_limit'),
    provider('mock-tool', 'mock:tool'),
    // بدون usage در پاسخ: گیت‌وی باید توکن را تخمین بزند (کارت ۶.۲)
    provider('mock-nousage', 'mock:no_usage'),
    // پروکسی خروجی (کارت ۴.۱۰): credential از SOCKS5 داخل کانتینر گیت‌وی عبور می‌کند
    // (`node scripts/dev/socks5-proxy.mjs`)، و provider با پروکسی مرده باید فال‌بک بدهد.
    provider('mock-socks', 'sk-mock', {
      credentials: [
        { ...cred('mock-socks-key', 'sk-mock'), proxy: { url: 'socks5h://127.0.0.1:1080' } },
      ],
    }),
    provider('mock-deadproxy', 'sk-mock', { proxy: { url: 'socks5://user:secret@127.0.0.1:1' } }),
    provider('mock-anthropic', 'sk-mock', { type: 'anthropic', baseUrl: mockRoot }),
    provider('mock-azure', 'sk-mock', {
      type: 'azure-openai',
      baseUrl: mockRoot,
      options: { apiVersion: '2024-10-21' },
    }),
    provider('mock-long', 'mock:chunks=600,chunk_delay=1000,text=' + 'x'.repeat(600), {
      timeouts: { totalMs: 900_000, idleMs: 30_000 },
    }),
  ],
  models: [
    model('mock/small', 'mock', 'mock-small'),
    model('mock/down', 'mock-down', 'mock-small'),
    model('mock/long', 'mock-long', 'mock-small'),
    model('mock/bad', 'mock-bad', 'mock-small'),
    model('mock/429', 'mock-429', 'mock-small'),
    model('mock/tool', 'mock-tool', 'mock-small'),
    model('mock/nousage', 'mock-nousage', 'mock-small'),
    model('mock/socks', 'mock-socks', 'mock-small'),
    model('mock/deadproxy', 'mock-deadproxy', 'mock-small'),
    model('mock/claude', 'mock-anthropic', 'claude-mock'),
    model('mock/azure', 'mock-azure', 'gpt-mock-deployment'),
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
    {
      id: 'cmb_dev_bad',
      organizationId: 'org_dev',
      slug: 'dev-bad',
      strategy: 'priority',
      targets: [
        { modelId: 'mock/bad', order: 0 },
        { modelId: 'mock/small', order: 1 },
      ],
    },
    {
      id: 'cmb_dev_proxy',
      organizationId: 'org_dev',
      slug: 'dev-proxy',
      strategy: 'priority',
      targets: [
        { modelId: 'mock/deadproxy', order: 0 },
        { modelId: 'mock/socks', order: 1 },
      ],
    },
    {
      id: 'cmb_dev_429',
      organizationId: 'org_dev',
      slug: 'dev-429',
      strategy: 'priority',
      targets: [
        { modelId: 'mock/429', order: 0 },
        { modelId: 'mock/claude', order: 1 },
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
    {
      id: 'vk_dev_limited',
      hash: hashApiKey(LIMITED_API_KEY, KEY_PEPPER),
      prefix: LIMITED_API_KEY.slice(0, 10),
      organizationId: 'org_dev',
      teamId: null,
      projectId: 'prj_dev',
      enabled: true,
      expiresAt: null,
      allowedModels: ['mock/small'],
    },
    {
      id: 'vk_dev_expired',
      hash: hashApiKey(EXPIRED_API_KEY, KEY_PEPPER),
      prefix: EXPIRED_API_KEY.slice(0, 10),
      organizationId: 'org_dev',
      teamId: null,
      projectId: 'prj_dev',
      enabled: true,
      expiresAt: '2020-01-01T00:00:00.000Z',
    },
    {
      // فقط از 203.0.113.7 (TEST-NET-3)؛ برای تست جعل X-Forwarded-For.
      id: 'vk_dev_ip',
      hash: hashApiKey(IP_API_KEY, KEY_PEPPER),
      prefix: IP_API_KEY.slice(0, 10),
      organizationId: 'org_dev',
      teamId: null,
      projectId: 'prj_dev',
      enabled: true,
      expiresAt: null,
      ipAllowlist: ['203.0.113.7/32'],
    },
  ],
  settings: { defaultTimeouts: { totalMs: 900_000 } },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snapshot));
process.stderr.write(`snapshot → ${out}\nکلید dev / dev key: ${DEV_API_KEY}\n`);
