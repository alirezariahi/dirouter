/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttributionUsage } from '../components/attribution-usage';
import { i18n, setupI18n } from '../i18n';
import type * as CsvModule from '../lib/csv';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import EndUsersPage from './end-users';

const csv = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
vi.mock('../lib/csv', async (original) => ({
  ...(await original<typeof CsvModule>()),
  downloadCsv: csv.downloadCsv,
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

const END_USERS = {
  total: 2,
  items: [
    {
      id: 'alice',
      blocked: false,
      firstSeenAt: '2026-11-01T10:00:00.000Z',
      lastSeenAt: '2026-11-24T10:00:00.000Z',
      hasLimits: true,
      month: { requests: 1200, costUsd: '14.5' },
    },
    {
      id: 'bob',
      blocked: true,
      firstSeenAt: null,
      lastSeenAt: null,
      hasLimits: false,
      month: { requests: 0, costUsd: '0' },
    },
  ],
};
const ALICE = {
  id: 'alice',
  blocked: false,
  firstSeenAt: '2026-11-01T10:00:00.000Z',
  lastSeenAt: '2026-11-24T10:00:00.000Z',
  month: { requests: 1200, costUsd: '14.5' },
  limits: {
    scope: 'end_user',
    scopeId: 'alice',
    name: 'alice',
    rpm: 30,
    tpm: null,
    maxConcurrency: null,
    budgets: [],
  },
  days: [{ day: '2026-11-24', requests: 1200, errors: 3, tokens: 50000, costUsd: '14.5' }],
};
const BY_USER = {
  dimension: 'end_user',
  groupBy: 'value',
  items: [
    {
      id: 'alice',
      requests: 1200,
      errors: 3,
      inputTokens: 40000,
      outputTokens: 10000,
      tokens: 50000,
      costUsd: '14.5',
      chargeUsd: '16',
    },
    {
      id: '__other__',
      requests: 9,
      errors: 0,
      inputTokens: 90,
      outputTokens: 10,
      tokens: 100,
      costUsd: '0.2',
      chargeUsd: '0.2',
    },
  ],
};

type Call = { path: string; method: string; query: string; body?: Record<string, unknown> };

function mockApi() {
  const calls: Call[] = [];
  const user = {
    id: 'usr_1',
    email: 'owner@example.com',
    name: 'Owner',
    organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role: 'OWNER' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/api\/v1/, '');
      const method = init.method ?? 'GET';
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ path, method, query: parsed.search, ...(body ? { body } : {}) });
      let response: unknown = {};
      if (path === '/auth/login') response = { accessToken: 'token' };
      else if (path === '/auth/me') response = user;
      else if (path === '/orgs/org_1/end-users') response = END_USERS;
      else if (path === '/orgs/org_1/end-users/alice') response = ALICE;
      else if (path === '/orgs/org_1/limits') response = [ALICE.limits];
      else if (path === '/orgs/org_1/stats/dimensions')
        response = parsed.searchParams.get('value')
          ? {
              ...BY_USER,
              groupBy: 'model',
              value: 'alice',
              items: [{ ...BY_USER.items[0], id: 'gpt-5' }],
            }
          : BY_USER;
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

async function renderWith(children: ReactNode) {
  await act(async () => {
    await login('owner@example.com', 'password');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsProvider>{children}</SettingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  resetSessionForTests();
  setupI18n('en');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  csv.downloadCsv.mockReset();
});

describe('end users page (card 33.2)', () => {
  it('lists end users with this month’s usage and blocks one', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderWith(<EndUsersPage />);
    const table = await screen.findByTestId('end-users');
    const alice = within(table).getByTestId('end-user-alice');
    expect(alice.textContent).toContain('$14.50');
    expect(alice.textContent).toContain('Own limits');
    expect(within(table).getByTestId('end-user-bob').textContent).toContain('Blocked');
    fireEvent.click(within(alice).getByRole('button', { name: 'Block alice' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
        path: '/orgs/org_1/end-users/alice',
        body: { blocked: true },
      });
    });
    expect((await screen.findByRole('status')).textContent).toBe('“alice” is blocked.');
    fireEvent.click(within(table).getByRole('button', { name: 'Unblock bob' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ blocked: false });
    });
  });

  it('sets the defaults every end user gets and shows one end user’s days and limits', async () => {
    const calls = mockApi();
    await renderWith(<EndUsersPage />);
    const defaults = await screen.findByTestId('end-user-defaults');
    fireEvent.click(within(defaults).getByRole('button', { name: 'Edit limits Every end user' }));
    const form = within(defaults).getByRole('form', { name: 'Edit limits Every end user' });
    fireEvent.change(within(form).getByLabelText('Daily budget (USD)'), {
      target: { value: '2' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/orgs/org_1/limits/end_user/*');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Details alice' }));
    const days = await screen.findByTestId('end-user-days');
    expect(days.textContent).toContain('$14.50');
    const limits = screen.getByTestId('end-user-limits');
    await waitFor(() => {
      expect(within(limits).getByTestId('limits-end_user-alice').textContent).toContain(
        '30 req/min',
      );
    });
  });
});

describe('usage by end user on the analytics page (card 33.2)', () => {
  it('ranks end users by cost, drills into one by model and exports CSV', async () => {
    const calls = mockApi();
    await renderWith(
      <AttributionUsage
        orgId="org_1"
        from="2026-11-17T00:00:00.000Z"
        to="2026-11-24T00:00:00.000Z"
        dimensions={['end_user']}
      />,
    );
    const list = await screen.findByTestId('attribution-end_user');
    expect(list.textContent).toContain('alice');
    expect(list.textContent).toContain('Other');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(csv.downloadCsv).toHaveBeenCalledWith(
      'dirouter-end_user-2026-11-17_2026-11-24.csv',
      ['end_user', 'requests', 'errors', 'input_tokens', 'output_tokens', 'cost_usd', 'charge_usd'],
      [
        ['alice', 1200, 3, 40000, 10000, '14.5', '16'],
        ['__other__', 9, 0, 90, 10, '0.2', '0.2'],
      ],
    );
    fireEvent.click(within(list).getByText('alice'));
    await waitFor(() => {
      expect(screen.getByTestId('attribution-end_user').textContent).toContain('gpt-5');
    });
    expect(calls.at(-1)?.query).toContain('value=alice');
    expect(calls.at(-1)?.query).toContain('groupBy=model');
  });
});
