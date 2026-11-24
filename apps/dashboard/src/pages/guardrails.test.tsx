/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import GuardrailsPage from './guardrails';

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

function mockApi(test: (body: Record<string, unknown>) => Reply) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const user = {
    id: 'usr_1',
    email: 'owner@example.com',
    name: 'Owner',
    organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role: 'OWNER' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ path, ...(body ? { body } : {}) });
      let response: Reply = { status: 200, body: {} };
      if (path === '/auth/login') response = { status: 200, body: { accessToken: 'token' } };
      else if (path === '/auth/me') response = { status: 200, body: user };
      else if (path === '/orgs/org_1') response = { status: 200, body: user.organizations[0] };
      else if (path.endsWith('/guardrails')) response = { status: 200, body: [] };
      else if (path.endsWith('/guardrails/test') && body) response = test(body);
      return Promise.resolve(
        new Response(JSON.stringify(response.body), {
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
        <GuardrailsPage />
      </SettingsProvider>
    </QueryClientProvider>,
  );
}

describe('guardrail live test (card 23.1)', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('sends the json_schema policy and lists the schema problems of the sample answer', async () => {
    const calls = mockApi(() => ({
      status: 200,
      body: {
        blocked: true,
        hit: true,
        matches: [],
        redacted: false,
        redactedText: '{"b":1}',
        valid: false,
        schemaErrors: ['$: missing required property "a"'],
      },
    }));
    await renderPage();
    fireEvent.change(await screen.findByLabelText('Type'), { target: { value: 'json_schema' } });
    fireEvent.change(screen.getByLabelText('JSON Schema'), {
      target: { value: '{"type":"object","required":["a"]}' },
    });
    expect(screen.getByText(/checked as the model’s answer/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sample text'), { target: { value: '{"b":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const preview = await screen.findByTestId('guardrail-preview');
    expect(within(preview).getByText('This text would be blocked.')).toBeTruthy();
    expect(within(preview).getByText('$: missing required property "a"')).toBeTruthy();
    const sent = calls.find((c) => c.path.endsWith('/guardrails/test'))?.body;
    expect(sent).toMatchObject({
      type: 'json_schema',
      config: { schema: { type: 'object', required: ['a'] } },
      text: '{"b":1}',
    });
  });

  it('says a flag policy lets the text through but records it', async () => {
    mockApi(() => ({
      status: 200,
      body: {
        blocked: false,
        hit: true,
        matches: ['sk-proj-…'],
        redacted: false,
        redactedText: 'x',
      },
    }));
    await renderPage();
    fireEvent.change(await screen.findByLabelText('Type'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'flag' } });
    fireEvent.change(screen.getByLabelText('Sample text'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const preview = await screen.findByTestId('guardrail-preview');
    expect(
      within(preview).getByText('This text would pass but be flagged in the log.'),
    ).toBeTruthy();
  });
});
