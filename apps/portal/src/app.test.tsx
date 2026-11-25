import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { usd } from './lib/format';
import { I18nProvider } from './lib/i18n-provider';
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

  it('an unverified account cannot create keys and can ask for a new link (23.4)', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: { accessToken: 'token' } }),
      'GET /auth/me': () => ({
        status: 200,
        body: {
          id: 'u',
          email: 'dev@example.com',
          name: 'Dev',
          emailVerified: false,
          organizations: [{ id: 'org1', name: 'W', role: 'OWNER' }],
        },
      }),
      'GET /orgs/org1/keys': () => ({ status: 200, body: [] }),
      'POST /portal/verify-email/resend': () => ({ status: 200, body: { sent: true } }),
    });
    navigate('/app/keys', true);
    renderApp();
    expect(await screen.findByText('Your email address is not verified yet.')).toBeTruthy();
    expect(screen.getByText('Verify your email address before creating keys.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create key' }).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText('A new link is on its way.')).toBeTruthy();
    expect(calls).toContain('POST /portal/verify-email/resend');
  });

  it('opens the emailed link and reports a used one (23.4)', async () => {
    let used = false;
    mockApi({
      'POST /auth/refresh': () => ({ status: 401 }),
      'POST /portal/verify-email': (init) => {
        const { token } = JSON.parse(init?.body as string) as { token: string };
        if (token !== 'tok-123' || used)
          return {
            status: 400,
            body: {
              code: 'verification_link_invalid',
              detail: 'This verification link has already been used',
            },
          };
        used = true;
        return { status: 200, body: { verified: true, email: 'dev@example.com' } };
      },
    });
    navigate('/verify-email?token=tok-123', true);
    renderApp();
    expect(await screen.findByText(/Your email is verified/)).toBeTruthy();
    cleanup();
    navigate('/verify-email?token=tok-123', true);
    renderApp();
    expect(await screen.findByText('This verification link has already been used')).toBeTruthy();
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

describe('usage and invoices (card 26.2)', () => {
  const signedIn = {
    'POST /auth/refresh': () => ({ status: 200, body: { accessToken: 'token' } }),
    'GET /auth/me': () => ({
      status: 200,
      body: {
        id: 'u',
        email: 'dev@example.com',
        name: 'Dev',
        organizations: [{ id: 'org1', name: 'W', role: 'OWNER' }],
      },
    }),
  };
  const bucket = (requests: number, cost: string) => ({
    requests,
    inputTokens: requests * 1000,
    outputTokens: requests * 100,
    costUsd: cost,
  });

  it('shows cost and tokens by day, model and key and the latest requests', async () => {
    const calls = mockApi({
      ...signedIn,
      'GET /orgs/org1/usage': () => ({
        status: 200,
        body: {
          from: '2026-10-26',
          to: '2026-11-25',
          basis: 'prepaid',
          totals: bucket(3, '4.37500000'),
          byDay: [
            { day: '2026-11-23', ...bucket(1, '3.12500000') },
            { day: '2026-11-24', ...bucket(2, '1.25000000') },
          ],
          byModel: [
            { model: 'shop/smart', ...bucket(1, '3.12500000') },
            { model: 'shop/fast', ...bucket(2, '1.25000000') },
          ],
          byKey: [{ apiKeyId: 'k1', name: 'ci key', prefix: 'p', ...bucket(3, '4.37500000') }],
          recent: [
            {
              requestId: 'req_1',
              createdAt: '2026-11-24T10:00:00Z',
              model: 'shop/fast',
              keyName: 'ci key',
              inputTokens: 1500,
              outputTokens: 300,
              costUsd: '0.75000000',
            },
          ],
        },
      }),
    });
    navigate('/app/usage', true);
    renderApp();
    expect((await screen.findAllByText('$4.375')).length).toBeGreaterThan(0);
    expect(screen.getByText(/match your statement/)).toBeTruthy();
    expect(screen.getAllByText('shop/smart').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ci key').length).toBe(2);
    expect(screen.getByText('$0.75')).toBeTruthy();
    expect(screen.getAllByText('3,000').length).toBeGreaterThan(0);
    // Only the signed-in workspace's data is ever asked for.
    const orgCalls = calls.filter((c) => c.includes('/orgs/'));
    expect(orgCalls.length).toBeGreaterThan(0);
    expect(orgCalls.every((c) => c.includes('/orgs/org1/'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => {
      expect(calls.filter((c) => c === 'GET /orgs/org1/usage').length).toBe(2);
    });
  });

  it('lists invoices with their VAT and downloads the PDF with the session token', async () => {
    const created = vi.fn(() => 'blob:invoice');
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    let auth: string | null = null;
    const calls = mockApi({
      ...signedIn,
      'GET /orgs/org1/invoices': () => ({
        status: 200,
        body: [
          {
            id: 'inv1',
            number: 'INV-2026-000007',
            period: '2026-10',
            basis: 'prepaid',
            closingUsd: '17.62500000',
            grossUsd: '6.37500000',
            netUsd: '5.79545455',
            vatUsd: '0.57954545',
            vatPercent: '10.00',
            createdAt: '2026-11-01T02:30:00Z',
          },
        ],
      }),
      'GET /orgs/org1/invoices/preview': () => ({
        status: 200,
        body: {
          period: '2026-11',
          basis: 'prepaid',
          totals: { usage: '-1.5' },
          closingUsd: '16.1',
        },
      }),
      'GET /orgs/org1/billing-profile': () => ({ status: 200, body: {} }),
      'GET /orgs/org1/invoices/inv1/pdf': (init) => {
        auth = new Headers(init?.headers).get('authorization');
        return { status: 200, body: '%PDF-' };
      },
    });
    navigate('/app/invoices', true);
    renderApp();
    expect(await screen.findByText('INV-2026-000007')).toBeTruthy();
    expect(screen.getByText('$0.57954545')).toBeTruthy();
    expect(screen.getByText('$6.375')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalled();
    });
    expect(auth).toBe('Bearer token');
    expect(created).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.includes('/orgs/')).every((c) => c.includes('/orgs/org1/'))).toBe(
      true,
    );
    click.mockRestore();
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
