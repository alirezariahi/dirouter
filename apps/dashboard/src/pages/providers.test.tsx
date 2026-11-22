/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import ProvidersPage from './providers';

const USER = {
  id: 'usr_1',
  email: 'owner@example.com',
  name: 'Owner',
  organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role: 'OWNER' as const }],
};
const CREDENTIAL = {
  id: 'cred_1',
  name: 'primary',
  secret: '••••2345',
  weight: 3,
  status: 'ACTIVE',
  cooldownUntil: '2026-11-08T12:00:00.000Z',
  headers: ['x-organization'],
  proxyUrl: 'socks5h://user:***@proxy:1080',
};
const PROVIDER = {
  id: 'prv_1',
  slug: 'openai-main',
  name: 'OpenAI main',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  proxyUrl: 'http://user:***@proxy:8080',
  timeouts: { connectMs: 5000, firstByteMs: 30000 },
  options: {},
  maxConcurrency: 20,
  credentials: [CREDENTIAL],
  createdAt: '2026-11-08T10:00:00.000Z',
};
const HEALTH = {
  gatewayReachable: true,
  nodes: [],
  models: [],
  providers: [
    {
      id: 'prv_1',
      name: 'OpenAI main',
      slug: 'openai-main',
      breaker: { state: 'open', total: 12, errors: 4, reopensAt: null },
      credentials: [
        {
          id: 'cred_1',
          name: 'primary',
          status: 'ACTIVE',
          cooldownUntil: '2026-11-08T12:00:00.000Z',
          disabledUntil: null,
          disabledReason: null,
          lockouts: [{ modelId: 'mdl_1', until: null }],
        },
      ],
    },
  ],
};
type Result = { status: number; body?: unknown };
type Handler = (path: string, init: RequestInit) => Result | undefined;
let calls: { path: string; init: RequestInit }[];
function mockApi(handler: Handler = () => undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      calls.push({ path, init });
      const result =
        handler(path, init) ??
        (path === '/auth/login'
          ? { status: 200, body: { accessToken: 'token' } }
          : path === '/auth/me'
            ? { status: 200, body: USER }
            : path === '/orgs/org_1/providers' && (!init.method || init.method === 'GET')
              ? { status: 200, body: [PROVIDER] }
              : path === '/orgs/org_1/health/runtime'
                ? { status: 200, body: HEALTH }
                : { status: 200, body: PROVIDER });
      return Promise.resolve(
        new Response(result.body === undefined ? null : JSON.stringify(result.body), {
          status: result.status,
          headers: {
            'content-type': result.status >= 400 ? 'application/problem+json' : 'application/json',
          },
        }),
      );
    }),
  );
}
async function renderPage() {
  await login('owner@example.com', 'password-for-test');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SettingsProvider>
        <ProvidersPage />
      </SettingsProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('OpenAI main')).toBeTruthy();
}
const click = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element);
  });
};
const body = (path: string, method: string, occurrence = 0) => {
  const call = calls.filter((c) => c.path === path && c.init.method === method)[occurrence];
  expect(call).toBeTruthy();
  return JSON.parse(call?.init.body as string) as Record<string, unknown>;
};

beforeEach(async () => {
  localStorage.clear();
  resetSessionForTests();
  setupI18n('en');
  await i18n.changeLanguage('en');
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('providers and credentials', () => {
  it('combines configuration and full runtime health without exposing secrets', async () => {
    mockApi();
    await renderPage();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('••••2345')).toBeTruthy();
    expect(screen.getByText('socks5h://user:***@proxy:1080')).toBeTruthy();
    expect(screen.getByText(/^Cooldown until /)).toBeTruthy();
    expect(screen.getByText('mdl_1')).toBeTruthy();
    expect(screen.queryByDisplayValue('sk-live-secret')).toBeNull();
    expect(calls.some((c) => c.path === '/orgs/org_1/health/runtime')).toBe(true);
  });

  it('uses a typed preset and creates a provider with its first weighted credential', async () => {
    mockApi();
    await renderPage();
    await click(screen.getByRole('button', { name: 'Add provider' }));
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'groq' } });
    await click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText<HTMLInputElement>('Base URL').value).toBe(
      'https://api.groq.com/openai/v1',
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fast Groq' } });
    fireEvent.change(screen.getByLabelText('Proxy URL'), {
      target: { value: 'socks5h://user:pass@proxy:1080' },
    });
    fireEvent.change(screen.getByLabelText('Connect timeout (ms)'), { target: { value: '2500' } });
    await click(screen.getByRole('button', { name: 'Next' }));
    const secret = screen.getByLabelText<HTMLInputElement>('API secret');
    expect(secret.type).toBe('password');
    fireEvent.change(secret, { target: { value: 'gsk-one-time-secret' } });
    fireEvent.change(screen.getByLabelText('Credential name'), {
      target: { value: 'main' },
    });
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '7' } });
    await click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(body('/orgs/org_1/providers', 'POST')).toEqual({
      name: 'Fast Groq',
      type: 'openai-compatible',
      baseUrl: 'https://api.groq.com/openai/v1',
      enabled: true,
      proxyUrl: 'socks5h://user:pass@proxy:1080',
      timeouts: { connectMs: 2500 },
      options: { preset: 'groq' },
      credentials: [{ name: 'main', secret: 'gsk-one-time-secret', weight: 7 }],
    });
  });

  it('adds a credential with headers and proxy, edits weight and rotates a secret', async () => {
    mockApi();
    await renderPage();
    await click(screen.getByRole('button', { name: 'Add credential' }));
    fireEvent.change(screen.getByLabelText('Credential name'), {
      target: { value: 'backup' },
    });
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('API secret'), {
      target: { value: 'sk-backup-secret' },
    });
    fireEvent.change(screen.getByLabelText('Additional headers'), {
      target: { value: 'x-organization: org_123\nx-project: proj_123' },
    });
    fireEvent.change(screen.getByLabelText('Credential proxy'), {
      target: { value: 'http://proxy:8080' },
    });
    await click(screen.getByRole('button', { name: 'Save' }));
    expect(body('/orgs/org_1/providers/prv_1/credentials', 'POST')).toEqual({
      name: 'backup',
      weight: 0,
      secret: 'sk-backup-secret',
      headers: { 'x-organization': 'org_123', 'x-project': 'proj_123' },
      proxyUrl: 'http://proxy:8080',
    });

    await click(screen.getByRole('button', { name: 'Rotate' }));
    expect(screen.getByLabelText<HTMLInputElement>('Credential name').value).toBe('primary');
    expect(screen.getByLabelText<HTMLInputElement>('Weight').value).toBe('3');
    expect(screen.getByLabelText<HTMLInputElement>('New secret (optional)').value).toBe('');
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '9' } });
    await click(screen.getByRole('button', { name: 'Save' }));
    expect(body('/orgs/org_1/providers/prv_1/credentials/cred_1', 'PATCH')).toEqual({
      name: 'primary',
      weight: 9,
    });

    await click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.change(screen.getByLabelText('New secret (optional)'), {
      target: { value: 'sk-rotated-once' },
    });
    await click(screen.getByRole('button', { name: 'Save' }));
    expect(body('/orgs/org_1/providers/prv_1/credentials/cred_1', 'PATCH', 1)).toMatchObject({
      name: 'primary',
      weight: 3,
    });
    expect(body('/orgs/org_1/providers/prv_1/credentials/cred_1', 'PATCH', 1).secret).toEqual(
      expect.any(String),
    );
  });

  it('tests provider and credential and toggles credential status', async () => {
    mockApi((path) =>
      path.endsWith('/test')
        ? { status: 200, body: { ok: true, latencyMs: 42, status: 200, modelCount: 8 } }
        : undefined,
    );
    await renderPage();
    await click(screen.getAllByRole('button', { name: 'Test' })[0] as HTMLElement);
    expect(body('/orgs/org_1/providers/prv_1/test', 'POST')).toEqual({});
    const row = screen.getByTestId('credential-cred_1');
    await click(within(row).getByRole('button', { name: 'Test' }));
    expect(body('/orgs/org_1/providers/prv_1/test', 'POST', 1)).toEqual({ credentialId: 'cred_1' });
    expect((await screen.findAllByText(/^Connection OK:/)).length).toBeGreaterThan(0);
    await click(within(row).getByRole('button', { name: 'Disable' }));
    expect(body('/orgs/org_1/providers/prv_1/credentials/cred_1', 'PATCH')).toEqual({
      status: 'DISABLED',
    });
  });

  it('discovers models and adds catalog-backed and manually priced models', async () => {
    mockApi((path) => {
      if (path.endsWith('/discover'))
        return {
          status: 200,
          body: {
            ok: true,
            latencyMs: 21,
            models: [
              {
                upstreamModel: 'gpt-known',
                inCatalog: true,
                suggested: false,
                catalog: { key: 'openai/gpt-known' },
              },
              {
                upstreamModel: 'gpt-new',
                inCatalog: false,
                suggested: true,
                catalog: { key: 'openai/gpt-new', contextWindow: 128000, pricing: {} },
              },
              { upstreamModel: 'unknown-model', inCatalog: false, suggested: true },
            ],
          },
        };
      if (path === '/orgs/org_1/models') return { status: 201, body: { id: 'mdl_new' } };
      return undefined;
    });
    await renderPage();
    await click(screen.getByRole('button', { name: 'Discover models' }));
    expect(await screen.findByText('gpt-new')).toBeTruthy();
    const known = screen.getAllByLabelText(/^Select /)[0] as HTMLInputElement;
    expect(known.disabled).toBe(true);
    const unknown = screen.getAllByLabelText(/^Select /)[2] as HTMLInputElement;
    expect(unknown.disabled).toBe(false);
    await click(screen.getAllByLabelText(/^Select /)[1] as HTMLElement);
    await click(unknown);
    fireEvent.change(screen.getByLabelText(/^Input price for /), {
      target: { value: '0.15' },
    });
    fireEvent.change(screen.getByLabelText(/^Output price for /), {
      target: { value: '0.60' },
    });
    await click(screen.getByRole('button', { name: 'Add selected' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(body('/orgs/org_1/models', 'POST')).toEqual({
      providerId: 'prv_1',
      upstreamModel: 'gpt-new',
      catalogKey: 'openai/gpt-new',
    });
    expect(body('/orgs/org_1/models', 'POST', 1)).toEqual({
      providerId: 'prv_1',
      upstreamModel: 'unknown-model',
      pricing: { inputPerMTok: '0.15', outputPerMTok: '0.60' },
    });
    expect(screen.getByRole('status').textContent).toContain('models added');
  });

  it('edits network settings and confirms provider deletion', async () => {
    mockApi();
    await renderPage();
    await click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText('Total (ms)'), { target: { value: '60000' } });
    await click(screen.getByRole('button', { name: 'Save' }));
    expect(body('/orgs/org_1/providers/prv_1', 'PATCH')).toEqual({
      name: 'Renamed',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      timeouts: { connectMs: 5000, firstByteMs: 30000, totalMs: 60000 },
      maxConcurrency: 20,
    });
    await click(screen.getAllByRole('button', { name: 'Delete' })[0] as HTMLElement);
    expect(confirm).toHaveBeenCalled();
    expect(
      calls.some((c) => c.path === '/orgs/org_1/providers/prv_1' && c.init.method === 'DELETE'),
    ).toBe(true);
  });

  it('keeps provider configuration read-only for viewers', async () => {
    mockApi((path) =>
      path === '/auth/me'
        ? {
            status: 200,
            body: {
              ...USER,
              organizations: [{ ...USER.organizations[0], role: 'VIEWER' }],
            },
          }
        : undefined,
    );
    await renderPage();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('••••2345')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add credential' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
  });
});
