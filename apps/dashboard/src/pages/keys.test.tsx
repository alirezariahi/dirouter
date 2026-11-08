/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import KeysPage from './keys';
import { i18n, setupI18n } from '../i18n';
import { resetSessionForTests, restoreSession } from '../lib/session';
import { SettingsProvider } from '../settings';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

const USER = {
  id: 'usr_1',
  email: 'owner@example.com',
  name: 'Owner',
  organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role: 'OWNER' }],
};
const PROJECTS = [
  {
    id: 'prj_1',
    name: 'Production',
    slug: 'production',
    createdAt: '2026-01-01T00:00:00Z',
    teamId: null,
  },
  {
    id: 'prj_2',
    name: 'Development',
    slug: 'development',
    createdAt: '2026-01-01T00:00:00Z',
    teamId: null,
  },
];
const KEY = {
  id: 'key_1',
  name: 'Production API',
  prefix: 'dr-prod1234',
  projectId: 'prj_1',
  state: 'active',
  allowedModels: ['gpt-4.1'],
  ipAllowlist: ['192.0.2.10'],
  rpm: 60,
  tpm: 100_000,
  maxConcurrency: 4,
  expiresAt: '2030-01-01T00:00:00Z',
  revokedAt: null,
  rotatedToId: null,
  lastUsedAt: '2026-11-08T10:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  budgets: [
    {
      id: 'bud_1',
      period: 'daily',
      limitUsd: '20',
      limitTokens: 1_000_000,
      alertThresholds: [80, 100],
    },
  ],
};
const KEYS = [
  KEY,
  {
    ...KEY,
    id: 'key_2',
    name: 'Revoked development',
    prefix: 'dr-dev56789',
    projectId: 'prj_2',
    state: 'revoked',
    allowedModels: [],
    ipAllowlist: [],
    rpm: null,
    tpm: null,
    maxConcurrency: null,
    expiresAt: null,
    lastUsedAt: null,
    budgets: [],
  },
];

type Call = { path: string; init: RequestInit };
function mockApi(role = 'OWNER') {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ path: `${path}${url.search}`, init });
      let body: unknown = {};
      if (path === '/auth/refresh') body = { accessToken: 'access-token' };
      else if (path === '/auth/me')
        body = { ...USER, organizations: [{ ...USER.organizations[0], role }] };
      else if (path === '/orgs/org_1/projects') body = PROJECTS;
      else if (path === '/orgs/org_1/keys' && init.method === 'POST')
        body = { ...KEY, key: 'dr-once-CREATE-SECRET' };
      else if (path === '/orgs/org_1/keys') body = KEYS;
      else if (path === '/orgs/org_1/stats/top')
        body = {
          items: [{ id: 'key_1', requests: 120, errors: 2, tokens: 45_000, costUsd: '1.25' }],
        };
      else if (path.endsWith('/rotate'))
        body = { ...KEY, key: 'dr-once-ROTATE-SECRET', previous: { ...KEY, state: 'rotating' } };
      else if (path.endsWith('/revoke')) body = { ...KEYS[0], state: 'revoked' };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

async function renderPage() {
  await act(async () => {
    await restoreSession();
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <KeysPage />
      </SettingsProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findAllByTestId('key-row')).toHaveLength(2);
  return { queryClient, ...result };
}

function expectNoSecret(secret: string, queryClient: QueryClient) {
  expect(document.body.textContent).not.toContain(secret);
  expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(secret);
  expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(secret);
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i += 1) {
      expect(storage.getItem(storage.key(i) ?? '')).not.toContain(secret);
    }
  }
}

describe('virtual key management', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
    // The translations are owned by a parallel task; isolate page behavior from that work.
    i18n.addResourceBundle(
      'en',
      'translation',
      {
        keys: {
          title: 'Virtual keys',
          create: 'Create virtual key',
          name: 'Key name',
          project: 'Project',
          search: 'Search keys',
          allProjects: 'All projects',
          stateLabel: 'Key state',
          allStates: 'All states',
          allModels: 'All models',
          never: 'Never',
          expires: 'Expires',
          requests: 'requests',
          tokens: 'tokens',
          allowedModels: 'Allowed models',
          listHint: 'Comma-separated; empty allows all models.',
          rpm: 'Requests per minute',
          tpm: 'Tokens per minute',
          maxConcurrency: 'Maximum concurrency',
          expiry: 'Expiry (optional)',
          ipAllowlist: 'IP allowlist',
          budgets: 'Budgets',
          budgetUsd: 'Cost limit (USD)',
          budgetTokens: 'Token limit',
          period: { daily: 'Daily', monthly: 'Monthly' },
          createTitle: 'Create a virtual key',
          editTitle: 'Edit virtual key',
          save: 'Save key',
          cancel: 'Cancel',
          edit: 'Edit',
          rotate: 'Rotate',
          revoke: 'Revoke',
          secretTitle: 'Your virtual key',
          secretWarning: 'This secret is shown only once.',
          copy: 'Copy key',
          copied: 'Copied',
          copyError: 'Could not copy',
          done: 'Done',
          rotateTitle: 'Rotate {{name}}',
          rotateWarning: 'The old key remains valid until the grace period ends.',
          graceHours: 'Old-key grace period (hours)',
          revokeTitle: 'Revoke {{name}}',
          revokeWarning: 'This action cannot be undone.',
          confirmRevoke: 'Revoke permanently',
          revokedNotice: 'Key revoked.',
          close: 'Close',
          empty: 'No virtual keys match these filters.',
          state: { active: 'Active', rotating: 'Rotating', expired: 'Expired', revoked: 'Revoked' },
          col: {
            name: 'Key',
            project: 'Project',
            status: 'Status',
            limits: 'Limits and budgets',
            usage: 'Usage',
            lastUsed: 'Last used',
            actions: 'Actions',
          },
        },
      },
      true,
      true,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads top usage by key and filters by search and project', async () => {
    const calls = mockApi();
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('$1.2500')).toBeTruthy();
    });
    const stats = calls.find((call) => call.path.startsWith('/orgs/org_1/stats/top?'));
    expect(stats?.path).toContain('by=key');
    expect(stats?.path).toContain('metric=cost');
    expect(stats?.path).toContain('limit=100');

    fireEvent.change(screen.getByLabelText('Search keys'), { target: { value: 'development' } });
    expect(screen.getAllByTestId('key-row')).toHaveLength(1);
    expect(screen.getByText('Revoked development')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search keys'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'prj_1' } });
    expect(screen.getAllByTestId('key-row')).toHaveLength(1);
    expect(screen.getByText('Production API')).toBeTruthy();
  });

  it('creates a restricted key and erases the one-time secret on close', async () => {
    const calls = mockApi();
    const { queryClient } = await renderPage();
    const copy = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create virtual key' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Key name'), { target: { value: 'CI key' } });
    fireEvent.change(dialog.getByLabelText('Project'), { target: { value: 'prj_2' } });
    fireEvent.change(dialog.getByLabelText('Allowed models'), {
      target: { value: 'gpt-4.1, gpt-4.1, claude-sonnet-4' },
    });
    fireEvent.change(dialog.getByLabelText('Requests per minute'), { target: { value: '120' } });
    fireEvent.change(dialog.getByLabelText('Tokens per minute'), { target: { value: '200000' } });
    fireEvent.change(dialog.getByLabelText('Maximum concurrency'), { target: { value: '8' } });
    fireEvent.change(dialog.getByLabelText('Expiry (optional)'), {
      target: { value: '2030-01-02T03:04' },
    });
    fireEvent.change(dialog.getByLabelText('IP allowlist'), {
      target: { value: '192.0.2.10, 2001:db8::/32' },
    });
    fireEvent.change(dialog.getAllByLabelText('Cost limit (USD)')[0] as HTMLElement, {
      target: { value: '12.50' },
    });
    fireEvent.change(dialog.getAllByLabelText('Token limit')[1] as HTMLElement, {
      target: { value: '5000000' },
    });
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Save key' }));
    });

    const post = calls.find(
      (call) => call.path === '/orgs/org_1/keys' && call.init.method === 'POST',
    );
    expect(JSON.parse(post?.init.body as string)).toEqual({
      name: 'CI key',
      projectId: 'prj_2',
      allowedModels: ['gpt-4.1', 'claude-sonnet-4'],
      ipAllowlist: ['192.0.2.10', '2001:db8::/32'],
      rpm: 120,
      tpm: 200000,
      maxConcurrency: 8,
      expiresAt: new Date('2030-01-02T03:04').toISOString(),
      budgets: [
        { period: 'daily', limitUsd: '12.50' },
        { period: 'monthly', limitTokens: 5000000 },
      ],
    });
    expect(screen.getByTestId('one-time-secret').textContent).toBe('dr-once-CREATE-SECRET');
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith('dr-once-CREATE-SECRET');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expectNoSecret('dr-once-CREATE-SECRET', queryClient);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses the rotation grace period and does not retain the secret after unmount', async () => {
    const calls = mockApi();
    const { queryClient, unmount } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Old-key grace period (hours)'), {
      target: { value: '0' },
    });
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Rotate' }));
    });
    const post = calls.find((call) => call.path.endsWith('/rotate'));
    expect(JSON.parse(post?.init.body as string)).toEqual({ graceSeconds: 0 });
    expect(screen.getByTestId('one-time-secret').textContent).toBe('dr-once-ROTATE-SECRET');
    unmount();
    expectNoSecret('dr-once-ROTATE-SECRET', queryClient);
  });

  it('edits restrictions and requires confirmation before revocation', async () => {
    const calls = mockApi();
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    const edit = within(screen.getByRole('dialog'));
    fireEvent.change(edit.getByLabelText('Key name'), { target: { value: 'Renamed key' } });
    fireEvent.change(edit.getByLabelText('Requests per minute'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(edit.getByRole('button', { name: 'Save key' }));
    });
    const patch = calls.find(
      (call) => call.path === '/orgs/org_1/keys/key_1' && call.init.method === 'PATCH',
    );
    expect(JSON.parse(patch?.init.body as string)).toMatchObject({
      name: 'Renamed key',
      rpm: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(calls.some((call) => call.path.endsWith('/revoke'))).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke permanently' }));
    });
    expect(calls.find((call) => call.path.endsWith('/revoke'))?.init.method).toBe('POST');
  });

  it('gives viewers read-only access', async () => {
    mockApi('VIEWER');
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Create virtual key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});
