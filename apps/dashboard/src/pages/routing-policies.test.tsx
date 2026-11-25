/** @vitest-environment jsdom */
/** Routing policies page (sprint 5). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import RoutingPoliciesPage from './routing-policies';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

type Reply = { status: number; body?: unknown };
type Handler = (path: string, method: string, body?: Record<string, unknown>) => Reply | undefined;

function mockApi(handler: Handler, role = 'OWNER') {
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
      let response: Reply = { status: 200, body: [] };
      if (path === '/auth/login') response = { status: 200, body: { accessToken: 'token' } };
      else if (path === '/auth/me') response = { status: 200, body: user };
      else if (path === '/orgs/org_1') response = { status: 200, body: user.organizations[0] };
      else response = handler(path, method, body) ?? response;
      return Promise.resolve(
        new Response(response.status === 204 ? null : JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

async function renderPage() {
  await act(async () => {
    await login('owner@example.com', 'password');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsProvider>
        <RoutingPoliciesPage />
      </SettingsProvider>
    </QueryClientProvider>,
  );
}

const RULE = {
  id: 'rrl_1',
  name: 'team over budget',
  enabled: true,
  priority: 10,
  teamId: 'team_1',
  projectId: null,
  condition: 'budget.team > 80',
  action: { type: 'route', target: 'cheap' },
};

describe('routing policies page', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists rules with their traffic share and checks a condition as it is typed (card 32.2)', async () => {
    const calls = mockApi((path, method, body) => {
      if (path.endsWith('/routing/rules') && method === 'GET') return { status: 200, body: [RULE] };
      if (path.endsWith('/routing/rules/traffic'))
        return {
          status: 200,
          body: { totalRequests: 4, rules: [{ id: 'rrl_1', matched: 2, decided: 2, share: 0.5 }] },
        };
      if (path.endsWith('/teams')) return { status: 200, body: [{ id: 'team_1', name: 'Search' }] };
      if (path.endsWith('/routing/rules/validate'))
        return {
          status: 200,
          body:
            body?.condition === 'nope'
              ? { valid: false, problem: "unknown variable 'nope'" }
              : { valid: true },
        };
      if (path.endsWith('/routing/rules') && method === 'POST') return { status: 201, body: RULE };
      return undefined;
    });
    await renderPage();
    expect(await screen.findByText('team over budget')).toBeTruthy();
    expect((await screen.findByTestId('rule-share-rrl_1')).textContent).toContain('50%');
    expect(screen.getByText('budget.team > 80')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Condition/), { target: { value: 'nope' } });
    expect((await screen.findByTestId('rule-condition-check')).textContent).toContain(
      "unknown variable 'nope'",
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'gold' } });
    fireEvent.change(screen.getByLabelText(/^Condition/), {
      target: { value: "request.headers['x-tier'] == 'gold'" },
    });
    expect(await screen.findByText('The condition is valid.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Target model, alias or combo'), {
      target: { value: 'big' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await vi.waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/routing/rules'))).toBe(
        true,
      );
    });
    expect(
      calls.find((c) => c.method === 'POST' && c.path.endsWith('/routing/rules'))?.body,
    ).toEqual({
      name: 'gold',
      condition: "request.headers['x-tier'] == 'gold'",
      action: { type: 'route', target: 'big' },
    });
  });

  it('shows splits with the branch comparison and rolls back or restores (card 32.3)', async () => {
    const split = {
      id: 'spl_1',
      version: 3,
      name: 'big to next',
      match: 'big',
      stable: 'big',
      canary: 'next',
      canaryPercent: 10,
      stickiness: 'key',
      autoRollback: { enabled: true, errorRate: 0.2 },
      state: 'active',
    };
    const branch = (model: string, errorRate: number) => ({
      model,
      requests: 10,
      errors: 0,
      errorRate,
      avgLatencyMs: 120,
      p95LatencyMs: 300,
      costUsd: '0.5',
      avgCostUsd: '0.05',
    });
    const calls = mockApi((path, method) => {
      if (path.endsWith('/routing/splits') && method === 'GET')
        return { status: 200, body: [split] };
      if (path.endsWith('/report'))
        return { status: 200, body: { stable: branch('big', 0), canary: branch('next', 0.25) } };
      if (path.endsWith('/versions'))
        return {
          status: 200,
          body: [
            {
              version: 3,
              reason: 'auto_rollback',
              createdAt: '',
              config: { canary: 'next', canaryPercent: 10 },
            },
            {
              version: 1,
              reason: 'created',
              createdAt: '',
              config: { canary: 'next', canaryPercent: 5 },
            },
          ],
        };
      if (path.endsWith('/rollback')) return { status: 200, body: split };
      return undefined;
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'Canary and splits' }));
    expect((await screen.findByTestId('split-canary')).textContent).toContain('25%');
    expect((await screen.findByTestId('split-stable')).textContent).toContain('big');
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to stable now' }));
    await vi.waitFor(() => {
      expect(calls.find((c) => c.path.endsWith('/rollback'))?.body).toEqual({});
    });
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    expect(await screen.findByText('rolled back automatically')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.path.endsWith('/rollback')).at(-1)?.body).toEqual({
        toVersion: 1,
      });
    });
  });

  it('shows shadow policies with the comparison and the daily cap (card 32.4)', async () => {
    const calls = mockApi((path, method) => {
      if (path.endsWith('/routing/shadows') && method === 'GET')
        return {
          status: 200,
          body: [
            {
              id: 'shd_1',
              name: 'try next',
              enabled: true,
              match: 'big',
              target: 'next',
              sampleRate: 0.25,
              dailyBudgetUsd: '5',
            },
          ],
        };
      if (path.endsWith('/report'))
        return {
          status: 200,
          body: {
            requests: 2,
            shadow: {
              model: 'next',
              errors: 1,
              avgLatencyMs: 300,
              p95LatencyMs: 390,
              costUsd: '0.002',
            },
            primary: { errors: 0, avgLatencyMs: 100, p95LatencyMs: 100, costUsd: '0.02' },
            today: { spentUsd: '5', dailyBudgetUsd: '5', capped: true },
          },
        };
      if (path.endsWith('/routing/shadows') && method === 'POST') return { status: 201, body: {} };
      return undefined;
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'Shadow traffic' }));
    expect((await screen.findByTestId('shadow-shadow')).textContent).toContain('300 ms');
    expect((await screen.findByTestId('shadow-primary')).textContent).toContain('100 ms');
    expect(
      screen.getByText('Today’s cap is reached; no shadow copies until tomorrow.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('Name clients ask for (or * for all)'), {
      target: { value: '*' },
    });
    fireEvent.change(screen.getByLabelText('Shadow model (one of your own)'), {
      target: { value: 'next' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }));
    await vi.waitFor(() => {
      expect(
        calls.find((c) => c.method === 'POST' && c.path.endsWith('/routing/shadows'))?.body,
      ).toEqual({
        name: 'n',
        match: '*',
        target: 'next',
        sampleRate: 0.1,
        dailyBudgetUsd: '5',
      });
    });
  });

  it('is read only without models:write', async () => {
    mockApi(
      (path) => (path.endsWith('/routing/rules') ? { status: 200, body: [RULE] } : undefined),
      'VIEWER',
    );
    await renderPage();
    expect(await screen.findByText('team over budget')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    expect(screen.getByText('Changing policies needs the models:write permission.')).toBeTruthy();
  });
});
