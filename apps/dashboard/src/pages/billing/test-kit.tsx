/** Test helpers for the billing pages: a fake API that records calls, and a signed-in render. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { vi } from 'vitest';

import { login } from '../../lib/session';
import { SettingsProvider } from '../../settings';

export type Reply = { status: number; body?: unknown; type?: string };
export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}
type Route = (call: Call) => Reply | undefined;

export const ALL_BILLING = ['billing:read', 'billing:write'];

export function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

/** The platform organization's owner, unless the test says otherwise. */
export function member(
  options: { isPlatform?: boolean; permissions?: string[]; role?: string } = {},
) {
  return {
    id: 'usr_1',
    email: 'op@example.com',
    name: 'Operator',
    organizations: [
      {
        id: 'org_p',
        name: 'Platform',
        slug: 'platform',
        role: options.role ?? 'OWNER',
        permissions: options.permissions ?? ALL_BILLING,
        isPlatform: options.isPlatform ?? true,
      },
    ],
  };
}

export function mockApi(route: Route, user = member()) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      const call: Call = {
        method: init.method ?? 'GET',
        path: parsed.pathname.replace(/^\/api\/v1/, ''),
        query: Object.fromEntries(parsed.searchParams),
        ...(typeof init.body === 'string'
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {}),
      };
      calls.push(call);
      const reply: Reply =
        call.path === '/auth/login' || call.path === '/auth/refresh'
          ? { status: 200, body: { accessToken: 'token' } }
          : call.path === '/auth/me'
            ? { status: 200, body: user }
            : (route(call) ?? { status: 404, body: { status: 404, code: 'not_found' } });
      const type =
        reply.type ?? (reply.status >= 400 ? 'application/problem+json' : 'application/json');
      const payload =
        reply.body instanceof Blob
          ? reply.body
          : reply.body === undefined
            ? null
            : JSON.stringify(reply.body);
      return Promise.resolve(
        new Response(payload, { status: reply.status, headers: { 'content-type': type } }),
      );
    }),
  );
  return calls;
}

export async function renderPage(Page: ComponentType) {
  await act(async () => {
    await login('op@example.com', 'password');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsProvider>
        <Page />
      </SettingsProvider>
    </QueryClientProvider>,
  );
}

/** Captures what `downloadCsv` / `downloadBlob` would save. */
export function captureDownloads() {
  const files: { name: string; blob: Blob }[] = [];
  let pending: Blob | undefined;
  // jsdom has no object URLs; these two are all the download helpers use.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      pending = blob;
      return 'blob:test';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (pending) files.push({ name: this.download, blob: pending });
    pending = undefined;
  });
  return files;
}
