/** @vitest-environment jsdom */
/** Provider plugin picker (card 21.2): the terms warning must be accepted before continuing. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { login, resetSessionForTests } from '../lib/session';
import { type PluginChoice, pluginChoiceReady } from '../lib/plugins';
import { PluginPicker } from './plugin-picker';

const PLUGINS = [
  { name: 'workers-ai', status: 'available', displayName: 'Workers AI', termsWarning: null },
  {
    name: 'bridge',
    status: 'available',
    displayName: 'Subscription bridge',
    termsWarning: { text: 'This may break the provider terms.' },
  },
  { name: 'broken', status: 'failed', error: 'invalid plugin.json' },
];

function Wizard() {
  const [choice, setChoice] = useState<PluginChoice>({ acceptTerms: false });
  return (
    <>
      <PluginPicker org="org_1" choice={choice} onChange={setChoice} />
      <button disabled={!pluginChoiceReady(choice)}>Next</button>
    </>
  );
}

describe('plugin picker', () => {
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
              ? { id: 'usr_1', organizations: [{ id: 'org_1', role: 'OWNER' }] }
              : PLUGINS;
        return Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
        );
      }),
    );
    await act(async () => {
      await login('owner@example.com', 'password');
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('continues at once for a plain plugin, but only after accepting a terms warning', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Wizard />
      </QueryClientProvider>,
    );
    const select = await screen.findByLabelText('Plugin');
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toHaveProperty('disabled', true);
    expect(screen.getByRole('option', { name: /failed to load/ })).toHaveProperty('disabled', true);

    fireEvent.change(select, { target: { value: 'workers-ai' } });
    expect(next).toHaveProperty('disabled', false);

    fireEvent.change(select, { target: { value: 'bridge' } });
    expect(screen.getByRole('alert').textContent).toContain('This may break the provider terms.');
    expect(next).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/accept responsibility/));
    expect(next).toHaveProperty('disabled', false);
  });
});
