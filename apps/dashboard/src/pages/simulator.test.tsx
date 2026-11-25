/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import SimulatorPage from './simulator';

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

function mockApi(simulation: Record<string, unknown>) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ path, ...(body ? { body } : {}) });
      let response: unknown = {};
      if (path === '/auth/login') response = { accessToken: 'token' };
      else if (path === '/auth/me') response = USER;
      else if (path.endsWith('/keys') || path.endsWith('/models')) response = [];
      else if (path.endsWith('/routes/simulate')) response = simulation;
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

async function renderPage() {
  await act(async () => {
    await login('owner@example.com', 'password');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsProvider>
        <SimulatorPage />
      </SettingsProvider>
    </QueryClientProvider>,
  );
}

const candidate = (model: string, signals: Record<string, number>) => ({
  modelId: model,
  model,
  provider: 'p',
  credentialId: `crd-${model}`,
  signals,
});

beforeEach(async () => {
  localStorage.clear();
  resetSessionForTests();
  setupI18n('en');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('routing simulator strategies (card 25.4)', () => {
  it('shows the chosen strategy, its explanation and the signal it sorted on', async () => {
    const calls = mockApi({
      ok: true,
      status: 200,
      kind: 'combo',
      combo: { id: 'c', slug: 'fast', strategy: 'latency' },
      candidates: [
        candidate('quick', { latencyMs: 120, costMicroUsd: 10, recentRequests: 3, inFlight: 0 }),
        candidate('slow', { costMicroUsd: 5, recentRequests: 0, inFlight: 0 }),
      ],
      skipped: [],
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Model, alias or combo/), {
      target: { value: 'fast' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    expect((await screen.findByTestId('simulator-strategy')).textContent).toBe(
      'Strategy: Lowest latency',
    );
    expect(
      screen.getByText(
        'Send to the target with the lowest recent latency, weighed by its in-flight requests.',
      ),
    ).toBeTruthy();
    const signals = screen.getAllByTestId('simulator-signal').map((node) => node.textContent);
    expect(signals).toEqual(['Recent latency: 120 ms', 'Recent latency: no data yet']);
    expect(calls.find((call) => call.path === '/orgs/org_1/routes/simulate')?.body).toMatchObject({
      model: 'fast',
    });
  });

  it.each([
    ['cost', { costMicroUsd: 3000 }, 'Estimated cost: $0.003'],
    ['least-used', { recentRequests: 4, inFlight: 1 }, 'Requests (last minute + in flight): 4 + 1'],
    ['headroom', { headroomTokens: 98000 }, 'Context left: 98,000'],
  ])('formats the %s signal', async (strategy, signals, text) => {
    mockApi({
      ok: true,
      status: 200,
      kind: 'combo',
      combo: { id: 'c', slug: 'x', strategy },
      candidates: [candidate('a', signals)],
      skipped: [],
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Model, alias or combo/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    expect((await screen.findByTestId('simulator-signal')).textContent).toBe(text);
  });

  it('shows no signal column for strategies that do not use live signals', async () => {
    mockApi({
      ok: true,
      status: 200,
      kind: 'combo',
      combo: { id: 'c', slug: 'x', strategy: 'priority' },
      candidates: [candidate('a', { costMicroUsd: 1 })],
      skipped: [],
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Model, alias or combo/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    expect((await screen.findByTestId('simulator-strategy')).textContent).toBe(
      'Strategy: Priority',
    );
    expect(screen.queryByTestId('simulator-signal')).toBeNull();
  });
});

describe('routing simulator provider preferences (card 32.1)', () => {
  it('sends the provider object and fallback models and shows their effect', async () => {
    const calls = mockApi({
      ok: true,
      status: 200,
      kind: 'combo',
      models: ['chat', 'backup'],
      preferences: { sort: 'throughput' },
      policy: { lockProvider: false, sources: [] },
      combo: { id: 'c', slug: 'chat', strategy: 'priority' },
      candidates: [candidate('a', { throughputTps: 85.5 })],
      skipped: [{ modelId: 'b', credentialId: 'k', reason: 'above_max_price_prompt' }],
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Model, alias or combo/), { target: { value: 'chat' } });
    fireEvent.change(screen.getByLabelText(/Fallback models/), { target: { value: 'backup' } });
    fireEvent.change(screen.getByLabelText(/Provider preferences/), {
      target: { value: '{"sort":"throughput","max_price":{"prompt":1}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    expect((await screen.findByTestId('simulator-throughput')).textContent).toBe(
      'Generation speed: 85.5 tokens/s',
    );
    expect(screen.getByTestId('simulator-models').textContent).toBe(
      'Models in order: chat → backup',
    );
    expect(screen.getByText('Input price above max_price')).toBeTruthy();
    expect(calls.find((call) => call.path === '/orgs/org_1/routes/simulate')?.body).toMatchObject({
      model: 'chat',
      models: ['backup'],
      provider: { sort: 'throughput', max_price: { prompt: 1 } },
    });
  });

  it('refuses provider preferences that are not a JSON object', async () => {
    const calls = mockApi({ ok: true, status: 200, candidates: [], skipped: [] });
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Model, alias or combo/), { target: { value: 'chat' } });
    fireEvent.change(screen.getByLabelText(/Provider preferences/), { target: { value: '[1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    expect(
      await screen.findByText('Provider preferences must be a valid JSON object.'),
    ).toBeTruthy();
    expect(calls.some((call) => call.path.endsWith('/routes/simulate'))).toBe(false);
  });
});

describe('routing simulator data policy (card 32.5)', () => {
  it('shows the effective data policy and the reasons it removed targets', async () => {
    mockApi({
      ok: false,
      status: 400,
      error: { code: 'no_provider_matches_data_policy', message: 'x' },
      dataPolicy: { requireZdr: true, denyTraining: true },
      skipped: [{ modelId: 'b', credentialId: 'k', reason: 'may_train_on_data' }],
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Model, alias or combo/), { target: { value: 'chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    expect((await screen.findByTestId('simulator-data-policy')).textContent).toBe(
      'Data policy: ZDR only · No training on data',
    );
    expect(screen.getByText('No provider satisfies the data policy.')).toBeTruthy();
    expect(screen.getByText('Provider may train on request data')).toBeTruthy();
  });
});
