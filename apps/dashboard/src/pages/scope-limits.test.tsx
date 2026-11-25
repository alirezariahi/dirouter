/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScopeUsageSection } from '../components/scope-usage';
import { i18n, setupI18n } from '../i18n';
import { limitBody, limitDraft } from '../lib/scope-limits';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import OrganizationPage from './organization';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
type Reply = { status: number; body?: unknown };
const TEAM = { id: 'team_1', name: 'Platform', slug: 'platform', createdAt: '2026-01-01' };
const PROJECT = {
  id: 'prj_1',
  name: 'Search',
  slug: 'search',
  createdAt: '2026-01-01',
  teamId: TEAM.id,
};
const LIMITS = [
  {
    scope: 'team',
    scopeId: TEAM.id,
    name: TEAM.name,
    rpm: 600,
    tpm: null,
    maxConcurrency: 20,
    budgets: [
      {
        id: 'bud_t',
        period: 'daily',
        limitUsd: '40',
        limitTokens: null,
        alertThresholds: [80, 100],
      },
    ],
  },
];
const USAGE = {
  dayStart: '2026-11-24T00:00:00.000Z',
  monthStart: '2026-11-01T00:00:00.000Z',
  scopes: [
    {
      scope: 'team',
      scopeId: TEAM.id,
      name: TEAM.name,
      today: { usd: '10', tokens: 120000 },
      month: { usd: '250.5', tokens: 3000000 },
      rateLimit: { rpm: 600, tpm: null, maxConcurrency: 20 },
      budgets: [
        {
          id: 'bud_t',
          period: 'daily',
          limitUsd: '40',
          limitTokens: null,
          alertThresholds: [80, 100],
          spentUsd: '10',
          spentTokens: 120000,
          usedPercent: 25,
        },
      ],
    },
    {
      scope: 'project',
      scopeId: PROJECT.id,
      name: PROJECT.name,
      teamId: TEAM.id,
      today: { usd: '0', tokens: 0 },
      month: { usd: '12.75', tokens: 90000 },
      rateLimit: null,
      budgets: [],
    },
  ],
};

function mockApi(
  role: Role,
  put: (body: Record<string, unknown>) => Reply = () => ({ status: 200 }),
) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const user = {
    id: 'usr_1',
    email: 'owner@example.com',
    name: 'Owner',
    organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      const method = init.method ?? 'GET';
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ path, method, ...(body ? { body } : {}) });
      let response: Reply = { status: 200, body: {} };
      if (path === '/auth/login') response = { status: 200, body: { accessToken: 'token' } };
      else if (path === '/auth/me') response = { status: 200, body: user };
      else if (path === '/orgs/org_1') response = { status: 200, body: user.organizations[0] };
      else if (path.endsWith('/members'))
        response = {
          status: 200,
          body: [{ userId: 'usr_2', email: 'dev@example.com', name: 'Dev', role: 'MEMBER' }],
        };
      else if (path.endsWith('/invitations')) response = { status: 200, body: [] };
      else if (path === '/orgs/org_1/models')
        response = { status: 200, body: [{ id: 'mdl_1', slug: 'openai/gpt-5' }] };
      else if (path === '/orgs/org_1/providers')
        response = { status: 200, body: [{ id: 'prv_1', name: 'OpenAI' }] };
      else if (path.endsWith('/teams')) response = { status: 200, body: [TEAM] };
      else if (path.endsWith('/projects')) response = { status: 200, body: [PROJECT] };
      else if (path === '/orgs/org_1/limits') response = { status: 200, body: LIMITS };
      else if (path === '/orgs/org_1/limits/usage') response = { status: 200, body: USAGE };
      else if (path.startsWith('/orgs/org_1/limits/') && method === 'PUT' && body)
        response = put(body);
      else if (path.startsWith('/orgs/org_1/limits/') && method === 'DELETE')
        response = { status: 200, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(response.body ?? {}), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

async function renderOrganization() {
  await act(async () => {
    await login('owner@example.com', 'password');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OrganizationPage />
    </QueryClientProvider>,
  );
  return screen.findByTestId('scope-limits');
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
});

describe('limit form helpers', () => {
  it('round-trips limits and validates like the API', () => {
    const draft = limitDraft(LIMITS[0] as never);
    expect(draft).toMatchObject({
      rpm: '600',
      maxConcurrency: '20',
      dailyUsd: '40',
      thresholds: '80, 100',
    });
    expect(limitBody(draft)).toEqual({
      ok: true,
      body: {
        rpm: 600,
        tpm: null,
        maxConcurrency: 20,
        budgets: [{ period: 'daily', limitUsd: '40', alertThresholds: [80, 100] }],
      },
    });
    expect(limitBody({ ...draft, rpm: '1.5' })).toMatchObject({ ok: false, field: 'rpm' });
    expect(limitBody({ ...draft, monthlyUsd: '0' })).toMatchObject({
      ok: false,
      field: 'monthlyUsd',
    });
    expect(limitBody({ ...draft, thresholds: '50, 150' })).toMatchObject({
      ok: false,
      rule: 'thresholds',
    });
    // Clearing every field removes every limit.
    expect(
      limitBody({
        rpm: '',
        tpm: '',
        maxConcurrency: '',
        dailyUsd: '',
        dailyTokens: '',
        weeklyUsd: '',
        weeklyTokens: '',
        monthlyUsd: '',
        monthlyTokens: '',
        yearlyUsd: '',
        yearlyTokens: '',
        thresholds: '',
      }),
    ).toEqual({ ok: true, body: { rpm: null, tpm: null, maxConcurrency: null, budgets: [] } });
  });
});

describe('team and project limits on the organization page (card 25.5)', () => {
  it('shows the current limits of each team and project', async () => {
    mockApi('OWNER');
    const card = await renderOrganization();
    await waitFor(() => {
      expect(within(card).getByTestId('limits-team-team_1').textContent).toContain(
        '600 req/min · 20 concurrent · daily $40.00',
      );
    });
    expect(within(card).getByTestId('limits-project-prj_1').textContent).toContain('No limits');
  });

  it('sets a project monthly budget with rate limits and thresholds from the UI', async () => {
    const calls = mockApi('OWNER');
    const card = await renderOrganization();
    fireEvent.click(within(card).getByRole('button', { name: 'Edit limits Search' }));
    const form = within(card).getByRole('form', { name: 'Edit limits Search' });
    fireEvent.change(within(form).getByLabelText('Monthly budget (USD)'), {
      target: { value: '25.50' },
    });
    fireEvent.change(within(form).getByLabelText('Requests per minute (RPM)'), {
      target: { value: '120' },
    });
    fireEvent.change(within(form).getByLabelText('Tokens per minute (TPM)'), {
      target: { value: '50000' },
    });
    fireEvent.change(within(form).getByLabelText('Alert thresholds (%)'), {
      target: { value: '90, 50' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put?.path).toBe('/orgs/org_1/limits/project/prj_1');
      expect(put?.body).toEqual({
        rpm: 120,
        tpm: 50000,
        maxConcurrency: null,
        budgets: [{ period: 'monthly', limitUsd: '25.50', alertThresholds: [50, 90] }],
      });
    });
    expect((await within(card).findByRole('status')).textContent).toBe('Limits of “Search” saved.');
  });

  it('says when a budget change waits for a second person', async () => {
    mockApi('ADMIN', () => ({
      status: 202,
      body: { changeRequest: { id: 'chr_1', summary: 'Change the budgets of project Search' } },
    }));
    const card = await renderOrganization();
    fireEvent.click(within(card).getByRole('button', { name: 'Edit limits Search' }));
    const form = within(card).getByRole('form', { name: 'Edit limits Search' });
    fireEvent.change(within(form).getByLabelText('Daily budget (USD)'), { target: { value: '5' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect((await within(card).findByRole('status')).textContent).toBe(
      'The budget change of “Search” is waiting for a second person’s approval.',
    );
  });

  it('refuses invalid values before calling the API and removes limits on request', async () => {
    const calls = mockApi('OWNER');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const card = await renderOrganization();
    await waitFor(() => {
      expect(within(card).getByTestId('limits-team-team_1').textContent).toContain('600');
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Edit limits Platform' }));
    const form = within(card).getByRole('form', { name: 'Edit limits Platform' });
    expect(within(form).getByLabelText<HTMLInputElement>('Daily budget (USD)').value).toBe('40');
    fireEvent.change(within(form).getByLabelText('Concurrency'), { target: { value: '-3' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect((await within(form).findByRole('alert')).textContent).toBe(
      '“Concurrency” must be a positive whole number.',
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(form).getByRole('button', { name: 'Remove all limits' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/orgs/org_1/limits/team/team_1');
    });
  });

  it('limits the whole organization, a member and a model with weekly and yearly budgets (card 33.1)', async () => {
    const calls = mockApi('OWNER');
    const card = await renderOrganization();
    expect(within(card).getByTestId('limits-organization-org_1').textContent).toContain(
      'Whole organization',
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Edit limits Acme' }));
    let form = within(card).getByRole('form', { name: 'Edit limits Acme' });
    fireEvent.change(within(form).getByLabelText('Weekly budget (USD)'), {
      target: { value: '700' },
    });
    fireEvent.change(within(form).getByLabelText('Yearly token cap'), {
      target: { value: '900000000' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put?.path).toBe('/orgs/org_1/limits/organization/org_1');
      expect(put?.body?.budgets).toEqual([
        { period: 'weekly', limitUsd: '700', alertThresholds: [50, 80, 100] },
        { period: 'yearly', limitTokens: 900000000, alertThresholds: [50, 80, 100] },
      ]);
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Edit limits Dev' }));
    form = within(card).getByRole('form', { name: 'Edit limits Dev' });
    fireEvent.change(within(form).getByLabelText('Requests per minute (RPM)'), {
      target: { value: '30' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'PUT').at(-1)?.path).toBe(
        '/orgs/org_1/limits/user/usr_2',
      );
    });
    // A model without limits yet is picked from the list, then edited like any other scope.
    const picker = await within(card).findByRole('combobox', { name: 'Limit a model or provider' });
    await waitFor(() => {
      expect(within(picker).getByText('Model: openai/gpt-5')).toBeTruthy();
    });
    fireEvent.change(picker, { target: { value: 'model:mdl_1' } });
    form = within(card).getByRole('form', { name: 'Edit limits openai/gpt-5' });
    fireEvent.change(within(form).getByLabelText('Monthly budget (USD)'), {
      target: { value: '100' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'PUT').at(-1)?.path).toBe(
        '/orgs/org_1/limits/model/mdl_1',
      );
    });
  });

  it('is read-only for members', async () => {
    mockApi('MEMBER');
    const card = await renderOrganization();
    expect(
      within(card).getByText('Only organization owners and admins can change limits.'),
    ).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Edit limits/ })).toBeNull();
  });
});

describe('team and project usage on the cost page (card 25.5)', () => {
  it('shows today, this month and each budget used per team and project', async () => {
    mockApi('VIEWER');
    await act(async () => {
      await login('owner@example.com', 'password');
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SettingsProvider>
          <ScopeUsageSection orgId="org_1" />
        </SettingsProvider>
      </QueryClientProvider>,
    );
    const table = await screen.findByTestId('scope-usage');
    const team = within(table).getByTestId('usage-team-team_1');
    expect(within(team).getByTestId('usage-today').textContent).toContain('$10.00');
    expect(within(team).getByTestId('usage-month').textContent).toContain('$250.50');
    expect(within(team).getByTestId('usage-budget').textContent).toContain('$10.00 of $40.00');
    expect(within(team).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(team.textContent).toContain('600 req/min · 20 concurrent');
    const project = within(table).getByTestId('usage-project-prj_1');
    expect(within(project).getByTestId('usage-month').textContent).toContain('$12.75');
    expect(project.textContent).toContain('No budget');
  });
});
