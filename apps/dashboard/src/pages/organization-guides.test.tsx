/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import GuidesPage from './guides';
import OrganizationPage from './organization';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
type Reply = { status: number; body?: unknown };

const TEAM = { id: 'team_1', name: 'Platform', slug: 'platform', createdAt: '2026-01-01' };
const PROJECT = { ...TEAM, id: 'prj_1', name: 'Website', teamId: TEAM.id };
const KEY = {
  id: 'key_1',
  name: 'Existing',
  prefix: 'dr-abcd…',
  projectId: PROJECT.id,
  state: 'active',
};
const PROFILE = {
  id: 'apf_1',
  name: 'Team Claude',
  tool: 'claude-code',
  mainModel: 'main-model',
  fastModel: 'fast-model',
};
const generated = (key: string) => ({
  files: [
    { name: 'claude-code.env', description: 'env', content: `ANTHROPIC_AUTH_TOKEN='${key}'` },
  ],
  script: `#!/bin/sh\n# ${key}`,
});

function mockApi(
  role: Role,
  override: (path: string, init: RequestInit) => Reply | undefined = () => undefined,
) {
  const calls: { path: string; init: RequestInit }[] = [];
  const user = {
    id: 'usr_1',
    email: 'owner@example.com',
    name: 'Owner',
    organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      calls.push({ path, init });
      let response = override(path, init);
      if (!response && path === '/auth/login')
        response = { status: 200, body: { accessToken: 'token' } };
      if (!response && path === '/auth/me') response = { status: 200, body: user };
      if (!response && path === '/orgs/org_1')
        response = { status: 200, body: user.organizations[0] };
      if (!response && path.endsWith('/members')) {
        response = {
          status: 200,
          body: [
            { userId: 'usr_1', email: user.email, name: user.name, role, joinedAt: '2026-01-01' },
            {
              userId: 'usr_2',
              email: 'member@example.com',
              name: 'Member',
              role: 'MEMBER',
              joinedAt: '2026-01-02',
            },
          ],
        };
      }
      if (!response && path.endsWith('/invitations')) {
        response = {
          status: 200,
          body: [
            { id: 'inv_1', email: 'pending@example.com', role: 'VIEWER', expiresAt: '2026-11-15' },
          ],
        };
      }
      if (!response && path.endsWith('/teams')) response = { status: 200, body: [TEAM] };
      if (!response && path.endsWith('/projects')) response = { status: 200, body: [PROJECT] };
      if (!response && path.endsWith('/keys')) response = { status: 200, body: [KEY] };
      if (!response && path.endsWith('/agent-profiles'))
        response = { status: 200, body: [PROFILE] };
      if (!response && path.endsWith('/preview'))
        response = { status: 200, body: generated('<YOUR_DIROUTER_KEY>') };
      if (!response && path.endsWith('/setup'))
        response = { status: 201, body: { keyId: 'key_2', key: 'dr-new', ...generated('dr-new') } };
      response ??= { status: 200, body: {} };
      return Promise.resolve(
        new Response(response.body === undefined ? null : JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

async function renderPage(page: React.ReactNode) {
  await act(async () => {
    await login('owner@example.com', 'password');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

describe('organization management (card 7.9)', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('invites a member, changes a role, and removes with confirmation', async () => {
    const calls = mockApi('OWNER', (path, init) =>
      path.endsWith('/invitations') && init.method === 'POST'
        ? {
            status: 201,
            body: {
              id: 'inv_2',
              email: 'new@example.com',
              role: 'VIEWER',
              expiresAt: '2026-11-15',
              token: 'token',
              url: 'https://app.example.com/invite/token',
            },
          }
        : undefined,
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage(<OrganizationPage />);
    expect(await screen.findByTestId('member-usr_2')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'VIEWER' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    });
    expect((await screen.findByTestId('invitation-url')).textContent).toContain('/invite/token');
    const invite = calls.find(
      (call) => call.path.endsWith('/invitations') && call.init.method === 'POST',
    );
    expect(JSON.parse(invite?.init.body as string)).toEqual({
      email: 'new@example.com',
      role: 'VIEWER',
    });

    fireEvent.change(within(screen.getByTestId('member-usr_2')).getByLabelText(/^Role for /), {
      target: { value: 'VIEWER' },
    });
    await waitFor(() => {
      expect(
        calls.some((call) => call.path.endsWith('/members/usr_2') && call.init.method === 'PATCH'),
      ).toBe(true);
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('member-usr_2')).getByRole('button', {
          name: 'Remove',
        }),
      );
    });
    expect(confirm.mock.calls.length).toBeGreaterThan(0);
    expect(
      calls.some((call) => call.path.endsWith('/members/usr_2') && call.init.method === 'DELETE'),
    ).toBe(true);
  });

  it('creates, updates and deletes teams and projects', async () => {
    const calls = mockApi('ADMIN');
    await renderPage(<OrganizationPage />);
    const teamForm = await screen.findByRole('form', { name: 'Create team' });
    fireEvent.change(teamForm.querySelector('[name="name"]') as Element, {
      target: { value: 'Research' },
    });
    await act(async () => {
      fireEvent.submit(teamForm);
    });
    expect(calls.some((call) => call.path.endsWith('/teams') && call.init.method === 'POST')).toBe(
      true,
    );

    const projectForm = screen.getByRole('form', { name: 'Create project' });
    fireEvent.change(projectForm.querySelector('[name="name"]') as Element, {
      target: { value: 'Search' },
    });
    fireEvent.change(projectForm.querySelector('[name="teamId"]') as Element, {
      target: { value: 'team_1' },
    });
    await act(async () => {
      fireEvent.submit(projectForm);
    });
    const project = calls.find(
      (call) => call.path.endsWith('/projects') && call.init.method === 'POST',
    );
    expect(JSON.parse(project?.init.body as string)).toMatchObject({
      name: 'Search',
      teamId: 'team_1',
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getAllByText('Edit')[0] as Element);
    fireEvent.change(screen.getAllByLabelText('Team name')[1] as Element, {
      target: { value: 'Core' },
    });
    await act(async () => {
      fireEvent.submit(
        screen.getAllByLabelText('Team name')[1]?.closest('form') as HTMLFormElement,
      );
    });
    expect(
      calls.some((call) => call.path.endsWith('/teams/team_1') && call.init.method === 'PATCH'),
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0] as Element);
    });
    expect(
      calls.some((call) => call.path.endsWith('/teams/team_1') && call.init.method === 'DELETE'),
    ).toBe(true);
  });

  it('limits member controls to project management and makes viewers read-only', async () => {
    mockApi('MEMBER');
    await renderPage(<OrganizationPage />);
    expect(await screen.findByRole('form', { name: 'Create project' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Create team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Name').disabled).toBe(true);
    cleanup();
    resetSessionForTests();

    mockApi('VIEWER');
    await renderPage(<OrganizationPage />);
    expect(await screen.findByTestId('project-prj_1')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Create project' })).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('tool connection guides (card 7.10)', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders every tool with a copyable snippet and never persists a pasted secret', async () => {
    mockApi('OWNER');
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    await renderPage(<GuidesPage />);
    expect((await screen.findByTestId('guide-snippet')).textContent).toContain('YOUR_DIROUTER_KEY');

    fireEvent.change(screen.getByLabelText('Key (kept in memory only)'), {
      target: { value: 'dr-test-secret' },
    });
    const tools = [
      'Claude Code',
      'Codex',
      'Cursor',
      'Cline',
      'Roo Code',
      'Continue',
      'Aider',
      'OpenAI Python',
      'OpenAI Node.js',
      'Anthropic SDK',
      'curl',
    ];
    for (const tool of tools) {
      fireEvent.click(screen.getByRole('tab', { name: tool }));
      expect(screen.getByRole('tab', { name: tool }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByTestId('guide-snippet').textContent).toContain('dr-test-secret');
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('dr-test-secret'));
    for (let index = 0; index < localStorage.length; index += 1) {
      expect(localStorage.getItem(localStorage.key(index) as string)).not.toContain(
        'dr-test-secret',
      );
    }
  });

  it('selects existing metadata but requires a secret, and can create a key', async () => {
    const calls = mockApi('MEMBER', (path, init) =>
      path.endsWith('/keys') && init.method === 'POST'
        ? { status: 201, body: { ...KEY, id: 'key_2', key: 'dr-new-secret' } }
        : undefined,
    );
    await renderPage(<GuidesPage />);
    fireEvent.change(await screen.findByLabelText('Existing key'), {
      target: { value: 'key_1' },
    });
    expect((await screen.findByTestId('guide-snippet')).textContent).toContain('YOUR_DIROUTER_KEY');
    expect(screen.getByTestId('guide-snippet').textContent).not.toContain('dr-abcd…');

    fireEvent.click(screen.getByRole('button', { name: 'Create a key' }));
    expect((await screen.findByTestId('guide-new-key')).textContent).toContain('dr-new-secret');
    expect(screen.getByTestId('guide-snippet').textContent).toContain('dr-new-secret');
    const created = calls.find(
      (call) => call.path.endsWith('/keys') && call.init.method === 'POST',
    );
    expect(JSON.parse(created?.init.body as string)).toEqual({
      name: 'tool-connection',
      projectId: 'prj_1',
    });
  });

  it('shows an API error and retries loading', async () => {
    mockApi('VIEWER', (path) =>
      path.endsWith('/keys')
        ? { status: 403, body: { status: 403, code: 'forbidden', detail: 'No access' } }
        : undefined,
    );
    await renderPage(<GuidesPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('No access');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('agent profiles: previews keyless files and sets up with a new key in the chosen project', async () => {
    const calls = mockApi('OWNER');
    await renderPage(<GuidesPage />);
    const panel = within(await screen.findByTestId('agent-profiles'));
    expect(await panel.findByText('Team Claude')).toBeTruthy();

    fireEvent.click(panel.getByRole('button', { name: 'Preview' }));
    const preview = await screen.findByTestId('agent-profile-output');
    expect(preview.textContent).toContain('<YOUR_DIROUTER_KEY>');
    expect(preview.textContent).not.toContain('shown only this once');

    fireEvent.click(panel.getByRole('button', { name: 'Set up with a new key' }));
    await waitFor(() => {
      expect(screen.getByTestId('agent-profile-output').textContent).toContain('dr-new');
    });
    expect(screen.getByText(/shown only this once/)).toBeTruthy();
    const setup = calls.find((c) => c.path.endsWith('/agent-profiles/apf_1/setup'));
    expect(JSON.parse(setup?.init.body as string)).toEqual({ projectId: PROJECT.id });
  });

  it('agent profiles: viewers can preview but not set up or create', async () => {
    mockApi('VIEWER');
    await renderPage(<GuidesPage />);
    const panel = within(await screen.findByTestId('agent-profiles'));
    expect(await panel.findByRole('button', { name: 'Preview' })).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Set up with a new key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create profile' })).toBeNull();
  });
});
