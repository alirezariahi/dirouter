/** @vitest-environment jsdom */
/** Catalog sync panel (card 27.5): pending price changes, approval, and hidden for other orgs. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import { CatalogSync } from './catalog-sync';

const STATUS = {
  settings: { mode: 'manual' },
  pendingProposals: 1,
  runs: [
    {
      id: 'csr_1',
      status: 'failed',
      sources: ['https://mirror.test/p.json'],
      mode: 'manual',
      added: 0,
      updated: 0,
      repriced: 0,
      proposed: 0,
      removed: 0,
      error: 'https://mirror.test/p.json: fetch failed',
      startedAt: '2026-11-25T10:00:00.000Z',
    },
  ],
};
const PROPOSALS = [
  {
    id: 'cpp_1',
    catalogKey: 'openai/gpt-4o',
    currentPricing: { inputPerMTok: '2.5', outputPerMTok: '10' },
    proposedPricing: { inputPerMTok: '3', outputPerMTok: '12' },
    changeFactor: '1.2',
    reason: 'manual_mode',
  },
];

let calls: { method: string; path: string; body?: unknown }[] = [];
let platform = true;

describe('catalog sync panel', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
    calls = [];
    platform = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          path,
          ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
        });
        const json = (body: unknown, status = 200) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: {
                'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
              },
            }),
          );
        if (path === '/auth/login') return json({ accessToken: 'token' });
        if (path === '/auth/me')
          return json({
            id: 'usr_me',
            email: 'me@x.test',
            organizations: [{ id: 'org_1', role: 'OWNER' }],
          });
        if (!platform) return json({ status: 404, title: 'Not Found', code: 'not_found' }, 404);
        if (path.endsWith('/catalog-sync')) return json(STATUS);
        if (path.endsWith('/proposals')) return json(PROPOSALS);
        if (path.endsWith('/approve'))
          return json({
            id: 'cpp_1',
            status: 'approved',
            catalogKey: 'openai/gpt-4o',
            appliedModels: 2,
          });
        return json({ ok: true });
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

  const renderPanel = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CatalogSync base="/orgs/org_1" canManage />
      </QueryClientProvider>,
    );

  it('lists price changes waiting for approval and approves one', async () => {
    renderPanel();
    const row = (await screen.findByText('openai/gpt-4o')).closest('li');
    expect(row?.textContent).toContain('2.5 / 10 → 3 / 12');
    expect(screen.getByTestId('catalog-sync-last').textContent).toContain(
      'failed, the last good catalog is kept',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/cpp_1/approve'))).toBe(
        true,
      );
    });
  });

  it('saves a mirror as the source', async () => {
    renderPanel();
    const sources = await screen.findByPlaceholderText(/mirror\.internal/);
    fireEvent.change(sources, { target: { value: 'https://mirror.internal/prices.json\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        enabled: true,
        sources: ['https://mirror.internal/prices.json'],
        mode: 'manual',
      });
    });
  });

  it('renders nothing for an organization that is not the platform', async () => {
    platform = false;
    renderPanel();
    await waitFor(() => {
      expect(calls.some((c) => c.path.endsWith('/catalog-sync'))).toBe(true);
    });
    expect(screen.queryByTestId('catalog-sync')).toBeNull();
  });
});
