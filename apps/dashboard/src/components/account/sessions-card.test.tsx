/** @vitest-environment jsdom */
/** The account page's session list (card 23.5): devices, the current one, and revoking. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { login, resetSessionForTests } from '../../lib/session';
import { SettingsProvider } from '../../settings';
import { SessionsCard } from './sessions-card';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

const SESSIONS = [
  {
    id: 'fam_here',
    device: 'Firefox on Linux',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
    ip: '10.1.1.1',
    createdAt: '2026-11-24T08:00:00.000Z',
    lastActiveAt: '2026-11-24T09:00:00.000Z',
    method: 'pwd',
    current: true,
  },
  {
    id: 'fam_phone',
    device: 'Safari on iOS',
    userAgent: null,
    ip: '10.2.2.2',
    createdAt: '2026-11-20T08:00:00.000Z',
    lastActiveAt: '2026-11-23T09:00:00.000Z',
    method: 'passkey',
    current: false,
  },
];

describe('sessions card', () => {
  const calls: { method: string; path: string; body?: string }[] = [];

  beforeEach(async () => {
    calls.length = 0;
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
        const method = init.method ?? 'GET';
        calls.push({ method, path, ...(typeof init.body === 'string' ? { body: init.body } : {}) });
        if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
        const body =
          path === '/auth/login'
            ? { accessToken: 'token' }
            : path === '/auth/me'
              ? { id: 'usr_me', email: 'me@x.test', organizations: [] }
              : path === '/auth/sessions/revoke-all'
                ? { revoked: 1 }
                : SESSIONS;
        return Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
        );
      }),
    );
    await act(async () => {
      await login('me@x.test', 'password');
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderCard() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <SettingsProvider>
        <QueryClientProvider client={client}>
          <SessionsCard />
        </QueryClientProvider>
      </SettingsProvider>,
    );
  }

  it('lists every session with device, address and the current one marked', async () => {
    renderCard();
    const here = await screen.findByTestId('session-fam_here');
    expect(here.textContent).toContain('Firefox on Linux');
    expect(here.textContent).toContain('This device');
    expect(here.textContent).toContain('10.1.1.1');
    const phone = screen.getByTestId('session-fam_phone');
    expect(phone.textContent).toContain('Safari on iOS');
    expect(phone.textContent).toContain('passkey');
    expect(phone.textContent).not.toContain('This device');
    // Only other devices get a sign-out button; this one signs out through "everywhere".
    expect(here.querySelector('button')).toBeNull();
  });

  it('revokes one session and signs out all others', async () => {
    renderCard();
    const phone = await screen.findByTestId('session-fam_phone');
    fireEvent.click(phone.querySelector('button') as HTMLButtonElement);
    await waitFor(() => {
      expect(calls).toContainEqual({ method: 'DELETE', path: '/auth/sessions/fam_phone' });
    });
    fireEvent.click(screen.getByText('Sign out all other devices'));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/auth/sessions/revoke-all',
        body: JSON.stringify({ includeCurrent: false }),
      });
    });
    expect(await screen.findByText('1 session(s) ended.')).toBeTruthy();
  });
});
