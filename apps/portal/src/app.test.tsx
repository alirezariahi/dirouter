import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { usd } from './lib/format';
import { I18nProvider } from './lib/i18n';
import { navigate } from './lib/router';
import { signOut } from './lib/session';

const market = {
  models: [
    {
      slug: 'shop/fast',
      name: 'shop/fast',
      contextWindow: 128000,
      capabilities: [],
      price: { inputPerMTok: '2.50000000', outputPerMTok: '10.00000000' },
    },
    {
      slug: 'shop/image',
      name: 'shop/image',
      contextWindow: null,
      capabilities: [],
      price: { perRequestUsd: '0.04000000' },
    },
  ],
  plans: [{ id: 'p1', name: 'Starter', priceUsd: '10.00000000', includedUsd: '12.00000000' }],
};

type Route = (init: RequestInit | undefined) => { status: number; body?: unknown };

function mockApi(routes: Record<string, Route>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const path = new URL(input).pathname.replace(/^\/api\/v1/, '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const route = routes[`${init?.method ?? 'GET'} ${path}`];
      const { status, body } = route ? route(init) : { status: 404, body: { title: 'not found' } };
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

const renderApp = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider>
        <App />
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  localStorage.setItem('dirouter.portal.lang', 'en');
});
afterEach(async () => {
  cleanup();
  await signOut();
  vi.unstubAllGlobals();
  navigate('/', true);
});

describe('portal', () => {
  it('shows the model market to visitors, with token and per-request prices', async () => {
    mockApi({
      'POST /auth/refresh': () => ({ status: 401 }),
      'GET /portal/market': () => ({ status: 200, body: market }),
    });
    renderApp();
    expect(await screen.findByText('shop/fast')).toBeTruthy();
    expect(screen.getByText('$2.50')).toBeTruthy();
    expect(screen.getByText('$0.04')).toBeTruthy();
    expect(screen.getByText('Starter')).toBeTruthy();
    expect(screen.getAllByText('Sign up').length).toBeGreaterThan(0);
  });

  it('signs up and lands on the home page with the balance', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 401 }),
      'GET /portal/config': () => ({
        status: 200,
        body: { signupEnabled: true, oidc: { enabled: false }, welcomeCreditUsd: '1.5' },
      }),
      'GET /portal/market': () => ({ status: 200, body: market }),
      'POST /portal/signup': (init) => {
        const body = JSON.parse(init?.body as string) as { email: string };
        return body.email === 'dev@example.com'
          ? { status: 201, body: { accessToken: 'token', expiresIn: 900 } }
          : { status: 409, body: { detail: 'exists' } };
      },
      'GET /auth/me': () => ({
        status: 200,
        body: {
          id: 'u',
          email: 'dev@example.com',
          name: 'Dev',
          organizations: [{ id: 'org1', name: 'W', role: 'OWNER' }],
        },
      }),
      'GET /orgs/org1/wallet': () => ({
        status: 200,
        body: {
          prepaid: true,
          wallet: { id: 'w', balanceUsd: '1.50000000', heldUsd: '0', availableUsd: '1.50000000' },
        },
      }),
    });
    navigate('/signup', true);
    renderApp();
    expect(await screen.findByText(/Welcome credit/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dev' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dev@example.com' } });
    fireEvent.change(screen.getByLabelText(/Password/), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/app');
    });
    expect((await screen.findAllByText('$1.50')).length).toBe(2);
    expect(screen.getByText(/Authorization: Bearer YOUR_KEY/)).toBeTruthy();
    expect(calls).toContain('POST /portal/signup');
  });

  it('sends visitors of private pages to sign in', async () => {
    mockApi({ 'POST /auth/refresh': () => ({ status: 401 }) });
    navigate('/app/keys', true);
    renderApp();
    await waitFor(() => {
      expect(window.location.pathname).toBe('/signin');
    });
  });
});

describe('money format', () => {
  it('keeps the precision an amount needs', () => {
    expect(usd('2.50000000')).toBe('$2.50');
    expect(usd('0.00000150')).toBe('$0.0000015');
    expect(usd('-0.25000000')).toBe('-$0.25');
    expect(usd('12')).toBe('$12.00');
  });
});
