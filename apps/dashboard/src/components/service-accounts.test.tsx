/** @vitest-environment jsdom */
/** Service accounts and management tokens on the security page (card 23.6). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import { parseIpList, presetScopes } from '../lib/management-tokens';
import { ServiceAccounts } from './service-accounts';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

const PERMS = ['keys:read', 'keys:write', 'projects:read', 'projects:write', 'usage:read'];
const ACCOUNTS = [
  {
    id: 'sa_ci',
    name: 'ci',
    description: null,
    role: 'MEMBER',
    permissions: PERMS,
    tokens: [
      {
        id: 'mtk_ro',
        name: 'grafana',
        prefix: 'drm_abcdefgh',
        scopes: ['keys:read', 'usage:read'],
        allowedIps: ['10.0.0.0/8'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        lastUsedAt: '2026-11-24T10:00:00.000Z',
        lastUsedIp: '10.1.1.1',
        revokedAt: null,
      },
      {
        id: 'mtk_old',
        name: 'old',
        prefix: 'drm_zzzzzzzz',
        scopes: ['keys:write'],
        allowedIps: [],
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        revokedAt: '2026-11-20T10:00:00.000Z',
      },
    ],
  },
];

describe('service accounts', () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];

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
        calls.push({
          method,
          path,
          ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
        });
        if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
        const body =
          path === '/auth/login'
            ? { accessToken: 'token' }
            : path === '/auth/me'
              ? { id: 'usr_me', email: 'me@x.test', organizations: [] }
              : path.endsWith('/tokens')
                ? { id: 'mtk_new', token: 'drm_secret-shown-once' }
                : method === 'POST'
                  ? { id: 'sa_new' }
                  : ACCOUNTS;
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: method === 'POST' ? 201 : 200,
            headers: { 'content-type': 'application/json' },
          }),
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

  function renderList(canManage: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <SettingsProvider>
        <QueryClientProvider client={client}>
          <ServiceAccounts base="/orgs/org_1" canManage={canManage} role="ADMIN" />
        </QueryClientProvider>
      </SettingsProvider>,
    );
  }

  it('maps presets to scopes the role grants and parses the IP list', () => {
    expect(presetScopes('read', PERMS, [])).toEqual(['keys:read', 'projects:read', 'usage:read']);
    expect(presetScopes('full', PERMS, [])).toEqual(PERMS);
    expect(presetScopes('custom', PERMS, ['keys:write', 'billing:write'])).toEqual(['keys:write']);
    expect(parseIpList(' 10.0.0.0/8\n2001:db8::1, 192.168.1.1 \n')).toEqual([
      '10.0.0.0/8',
      '2001:db8::1',
      '192.168.1.1',
    ]);
  });

  it('lists accounts and tokens without the secret, with status and restrictions', async () => {
    renderList(false);
    const token = await screen.findByTestId('token-mtk_ro');
    expect(token.textContent).toContain('drm_abcdefgh');
    expect(token.textContent).toContain('read-only');
    expect(token.textContent).toContain('Limited to 1 address(es)');
    expect(token.textContent).toContain('10.1.1.1');
    expect(screen.getByTestId('token-mtk_old').textContent).toContain('Revoked');
    // Without security:write there is nothing to click.
    expect(screen.queryByText('Create token')).toBeNull();
    expect(screen.queryByText('Revoke')).toBeNull();
  });

  it('issues a read-only token, shows it once, and revokes tokens', async () => {
    renderList(true);
    const form = await screen.findByTestId('token-form-sa_ci');
    fireEvent.change(form.querySelector('input[name="token-name-sa_ci"]') as HTMLInputElement, {
      target: { value: 'terraform' },
    });
    fireEvent.change(form.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '10.0.0.0/8' },
    });
    fireEvent.submit(form);
    expect((await screen.findByTestId('management-token')).textContent).toContain(
      'drm_secret-shown-once',
    );
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/orgs/org_1/service-accounts/sa_ci/tokens',
      body: {
        name: 'terraform',
        scopes: ['keys:read', 'projects:read', 'usage:read'],
        expiresInDays: 90,
        allowedIps: ['10.0.0.0/8'],
      },
    });
    fireEvent.click(screen.getByText('Revoke'));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: '/orgs/org_1/management-tokens/mtk_ro',
      });
    });
  });
});
