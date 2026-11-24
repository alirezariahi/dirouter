/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { parseHeaders, serverBody } from '../lib/mcp';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import McpPage from './mcp';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

const SERVERS = [
  {
    id: 'mcp_docs',
    name: 'Docs',
    slug: 'docs',
    transport: 'streamable-http',
    url: 'https://docs.example.com/mcp',
    hasHeaders: true,
    enabled: true,
    forwardIdentity: false,
    timeoutMs: 60000,
  },
  {
    id: 'mcp_agent',
    name: 'Planner',
    slug: 'planner',
    transport: 'a2a',
    url: 'https://agents.example.com/planner',
    hasHeaders: false,
    enabled: true,
    forwardIdentity: true,
    timeoutMs: 60000,
  },
];
const KEYS = [
  {
    id: 'key_1',
    name: 'CI bot',
    prefix: 'dr-ci',
    projectId: 'prj_1',
    state: 'active',
    allowedModels: [],
    mcpTools: [],
    mcpAdmin: 'none',
    ipAllowlist: [],
    rpm: null,
    tpm: null,
    maxConcurrency: null,
    expiresAt: null,
  },
];
const CALLS = [
  {
    id: 'call_1',
    occurredAt: '2026-11-24T10:00:00.000Z',
    apiKeyId: 'key_1',
    projectId: 'prj_1',
    serverId: 'mcp_docs',
    tool: 'search',
    arguments: { query: 'refund policy', token: '***' },
    status: 'success',
    errorMessage: null,
    latencyMs: 231,
  },
];

type Call = { path: string; method: string; query: string; body?: Record<string, unknown> };

function mockApi(role = 'OWNER') {
  const calls: Call[] = [];
  const user = {
    id: 'usr_1',
    email: 'owner@example.com',
    name: 'Owner',
    organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/api\/v1/, '');
      const method = init.method ?? 'GET';
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ path, method, query: parsed.search, ...(body ? { body } : {}) });
      let response: unknown = {};
      let status = 200;
      if (path === '/auth/login') response = { accessToken: 'token' };
      else if (path === '/auth/me') response = user;
      else if (path === '/orgs/org_1/mcp/servers' && method === 'GET') response = SERVERS;
      else if (path === '/orgs/org_1/mcp/servers' && method === 'POST')
        response = { ...SERVERS[0], ...body, id: 'mcp_new' };
      else if (path === '/orgs/org_1/mcp/servers/mcp_docs/test')
        response = {
          ok: true,
          latencyMs: 87,
          tools: [
            { name: 'search', description: 'Search the docs' },
            { name: 'fetch', description: 'Fetch a page' },
          ],
        };
      else if (path === '/orgs/org_1/mcp/servers/mcp_agent/test')
        response = {
          ok: true,
          latencyMs: 40,
          agentName: 'Planner agent',
          tools: [{ name: 'Plan', description: 'Plans a trip' }],
        };
      else if (path === '/orgs/org_1/mcp/calls')
        response = parsed.searchParams.get('status') === 'error' ? [] : CALLS;
      else if (path === '/orgs/org_1/keys') response = KEYS;
      else if (path.startsWith('/orgs/org_1/keys/')) response = { ...KEYS[0], ...body };
      else status = 404;
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status,
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
        <McpPage />
      </SettingsProvider>
    </QueryClientProvider>,
  );
  await screen.findByTestId('mcp-servers');
}

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

describe('MCP header helpers', () => {
  it('parses Name: value lines and reports the first bad line', () => {
    expect(parseHeaders('Authorization: Bearer abc\n\nX-Team: core')).toEqual({
      Authorization: 'Bearer abc',
      'X-Team': 'core',
    });
    expect(parseHeaders('Authorization: x\nnot a header')).toEqual({ badLine: 2 });
  });

  it('keeps stored headers on edit unless they are replaced', () => {
    const draft = {
      id: 'mcp_1',
      name: 'Docs',
      slug: 'docs',
      transport: 'sse' as const,
      url: 'https://x.example/mcp',
      headers: '',
      replaceHeaders: false,
      hadHeaders: true,
      forwardIdentity: false,
      enabled: true,
      timeoutMs: '5000',
    };
    expect(serverBody(draft)).not.toHaveProperty('headers');
    expect(serverBody({ ...draft, replaceHeaders: true })).toMatchObject({ headers: null });
    expect(serverBody({ ...draft, replaceHeaders: true, headers: 'A: 1' })).toMatchObject({
      headers: { A: '1' },
    });
  });
});

describe('MCP and agents page (card 25.3)', () => {
  it('registers a server with encrypted headers and identity forwarding', async () => {
    const calls = mockApi();
    await renderPage();
    const form = screen.getByTestId('mcp-form');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Search' } });
    fireEvent.change(within(form).getByLabelText('Slug (tool prefix)'), {
      target: { value: 'search' },
    });
    fireEvent.change(within(form).getByLabelText('Transport'), { target: { value: 'sse' } });
    fireEvent.change(within(form).getByLabelText('URL'), {
      target: { value: 'https://search.example.com/sse' },
    });
    fireEvent.change(within(form).getByLabelText('Headers'), {
      target: { value: 'Authorization: Bearer upstream' },
    });
    fireEvent.click(within(form).getByLabelText(/Forward caller identity/));
    fireEvent.click(within(form).getByRole('button', { name: 'Register' }));
    await waitFor(() => {
      expect(
        calls.find((c) => c.path === '/orgs/org_1/mcp/servers' && c.method === 'POST')?.body,
      ).toEqual({
        name: 'Search',
        slug: 'search',
        transport: 'sse',
        url: 'https://search.example.com/sse',
        headers: { Authorization: 'Bearer upstream' },
        forwardIdentity: true,
        enabled: true,
        timeoutMs: 60000,
      });
    });
  });

  it('refuses a malformed header line before calling the API', async () => {
    const calls = mockApi();
    await renderPage();
    const form = screen.getByTestId('mcp-form');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(within(form).getByLabelText('Slug (tool prefix)'), {
      target: { value: 'x' },
    });
    fireEvent.change(within(form).getByLabelText('URL'), {
      target: { value: 'https://x.example.com/mcp' },
    });
    fireEvent.change(within(form).getByLabelText('Headers'), {
      target: { value: 'no colon here' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Register' }));
    expect((await within(form).findByRole('alert')).textContent).toBe(
      'Line 1 is not valid; write it as Name: value.',
    );
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/mcp/servers'))).toBe(false);
  });

  it('tests a server and shows its tools, and lists A2A agents with their skills', async () => {
    mockApi();
    await renderPage();
    const servers = screen.getByTestId('mcp-servers');
    expect(within(servers).getAllByTestId('mcp-server')).toHaveLength(1);
    fireEvent.click(within(servers).getByRole('button', { name: 'Test connection' }));
    const result = await within(servers).findByTestId('mcp-test-result');
    expect(result.textContent).toContain('Connected in 87 ms; 2 tools');
    expect(within(result).getByTestId('mcp-tools').textContent).toContain(
      'docs__search — Search the docs',
    );

    const agents = screen.getByTestId('a2a-agents');
    expect(agents.textContent).toContain('Planner');
    expect(agents.textContent).toContain('/a2a/agents/planner');
    fireEvent.click(within(agents).getByRole('button', { name: 'Test connection' }));
    expect((await within(agents).findByTestId('mcp-test-result')).textContent).toContain(
      'Planner agent answered in 40 ms; 1 skills',
    );
  });

  it('edits the tool allow-list of a key from the discovered tools', async () => {
    const calls = mockApi();
    await renderPage();
    const section = screen.getByTestId('mcp-allow-list');
    fireEvent.change(within(section).getByLabelText('Virtual key'), {
      target: { value: 'key_1' },
    });
    expect(within(section).getByTestId('mcp-allow-current').textContent).toBe('Now: All tools');
    fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
    fireEvent.click(within(section).getByLabelText('Only the selected tools'));
    fireEvent.click(await within(section).findByLabelText('docs__search'));
    fireEvent.click(within(section).getByLabelText('Every tool of planner'));
    fireEvent.change(within(section).getByLabelText('Other patterns'), {
      target: { value: 'legacy__lookup' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Save access' }));
    await waitFor(() => {
      expect(
        calls.find((c) => c.path === '/orgs/org_1/keys/key_1' && c.method === 'PATCH')?.body,
      ).toEqual({ mcpTools: ['docs__search', 'planner__*', 'legacy__lookup'] });
    });
    expect(await within(section).findByText('Access saved.')).toBeTruthy();

    // An invalid pattern is refused locally.
    fireEvent.change(within(section).getByLabelText('Other patterns'), {
      target: { value: 'Bad Pattern' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Save access' }));
    expect((await within(section).findByRole('alert')).textContent).toBe(
      'The pattern “Bad” is not valid.',
    );
  });

  it('shows the tool-call log with masked arguments and latency, and filters it', async () => {
    const calls = mockApi();
    await renderPage();
    const table = await screen.findByTestId('mcp-calls');
    expect(within(table).getByText('docs__search')).toBeTruthy();
    expect(within(table).getByTestId('mcp-call-arguments').textContent).toBe(
      '{"query":"refund policy","token":"***"}',
    );
    expect(within(table).getByTestId('mcp-call-latency').textContent).toBe('231 ms');
    expect(within(table).getByText('CI bot')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'error' } });
    fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'mcp_docs' } });
    expect(await screen.findByText('No calls match these filters.')).toBeTruthy();
    const last = calls.filter((c) => c.path === '/orgs/org_1/mcp/calls').at(-1);
    expect(new URLSearchParams(last?.query).get('status')).toBe('error');
    expect(new URLSearchParams(last?.query).get('serverId')).toBe('mcp_docs');
  });

  it('is read-only without mcp:write', async () => {
    mockApi('VIEWER');
    await renderPage();
    expect(screen.getByTestId('mcp-read-only')).toBeTruthy();
    expect(screen.queryByTestId('mcp-form')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  });
});
