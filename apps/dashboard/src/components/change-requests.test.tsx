/** @vitest-environment jsdom */
/** Change requests in the dashboard (card 22.2): the queued notice and the approval panel. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { CHANGE_REQUEST_EVENT } from '../lib/api';
import { login, resetSessionForTests } from '../lib/session';
import { ChangeRequestNotice } from './change-request-notice';
import { ChangeRequests } from './change-requests';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const REQUESTS = [
  {
    id: 'chr_1',
    kind: 'provider.delete',
    summary: 'Delete provider OpenAI',
    status: 'pending',
    requestedById: 'usr_me',
    createdAt: '2026-11-23',
  },
  {
    id: 'chr_2',
    kind: 'member.role',
    summary: 'Change the role of b@x.test to ADMIN',
    status: 'pending',
    requestedById: 'usr_other',
    createdAt: '2026-11-23',
  },
];

describe('change requests', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
        const body =
          path === '/auth/login'
            ? { accessToken: 'token' }
            : path === '/auth/me'
              ? {
                  id: 'usr_me',
                  email: 'me@x.test',
                  organizations: [{ id: 'org_1', role: 'OWNER' }],
                }
              : path.endsWith('/members')
                ? [{ userId: 'usr_other', email: 'other@x.test' }]
                : REQUESTS;
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

  it('a queued change shows a notice with its summary', () => {
    render(<ChangeRequestNotice />);
    expect(screen.queryByTestId('change-request-notice')).toBeNull();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CHANGE_REQUEST_EVENT, { detail: { summary: 'Delete provider OpenAI' } }),
      );
    });
    expect(screen.getByTestId('change-request-notice').textContent).toContain(
      'Delete provider OpenAI',
    );
  });

  it('my own request can only be cancelled; another member’s can be approved', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ChangeRequests base="/orgs/org_1" />
      </QueryClientProvider>,
    );
    const mine = (await screen.findByText('Delete provider OpenAI')).closest('li');
    const theirs = screen.getByText(/Change the role/).closest('li');
    expect(mine?.textContent).toContain('Cancel');
    expect(mine?.textContent).not.toContain('Approve');
    expect(theirs?.textContent).toContain('Approve and apply');
    expect(await screen.findByText('Requested by other@x.test')).toBeTruthy();
  });
});
