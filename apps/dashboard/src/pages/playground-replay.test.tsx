/** @vitest-environment jsdom */
/** Replay of a captured request in the playground (card 24.1). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, apiStream } from '../lib/api';
import { storeReplay, takeReplay } from '../lib/replay';
import PlaygroundPage from './playground';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../settings', () => ({ useSettings: () => ({ lang: 'en', calendar: 'gregory' }) }));
vi.mock('../lib/session', () => ({ currentOrg: () => ({ id: 'org_1' }) }));
vi.mock('../lib/s2-format', () => ({
  useFormat: () => ({ n: String, usd: String }),
  listOf: (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []),
}));
vi.mock(import('../lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  api: vi.fn(),
  apiStream: vi.fn(),
}));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PlaygroundPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(apiStream).mockReset();
  vi.mocked(apiStream).mockImplementation(() =>
    Promise.resolve(
      new Response('event: end\ndata: {"latencyMs":1}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ),
  );
  vi.mocked(api).mockImplementation((path) =>
    Promise.resolve(
      path.endsWith('/models')
        ? [
            { id: 'm1', slug: 'model-a' },
            { id: 'm2', slug: 'model-b' },
          ]
        : { apiKeyId: 'key_1', results: [] },
    ),
  );
});
afterEach(cleanup);

describe('playground replay', () => {
  it('opens with the stored conversation and sends it to the chosen model', async () => {
    storeReplay({
      requestId: 'req_9',
      model: 'model-a',
      system: 'be brief',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
      ],
      prompt: 'second',
      maxTokens: 9000,
      temperature: 0.4,
      lossy: true,
    });
    mount();
    expect(screen.getByTestId('playground-replay').textContent).toContain('req_9');
    expect(screen.getByTestId('playground-replay').textContent).toContain('earlier turns: 2');
    expect(screen.getByLabelText<HTMLTextAreaElement>('s2.playground.system').value).toBe(
      'be brief',
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('s2.playground.prompt').value).toBe('second');
    // The playground's own cap applies to a replayed output limit.
    expect(screen.getByLabelText<HTMLInputElement>('s2.playground.maxTokens').value).toBe('4096');
    // Taken once: a reload does not bring it back.
    expect(takeReplay()).toBeUndefined();

    // Any model, not only the one the request used.
    fireEvent.click(await screen.findByText('model-b'));
    fireEvent.change(screen.getByLabelText('s2.playground.key'), {
      target: { value: 'dr-my-own-key-000000' },
    });
    fireEvent.click(screen.getByText('s2.playground.run'));
    await waitFor(() => {
      expect(vi.mocked(apiStream).mock.calls.length).toBe(1);
    });
    // The playground streams each model (card 25.6); the replayed turns go along.
    const call = vi.mocked(apiStream).mock.calls[0];
    expect(call?.[0]).toBe('/orgs/org_1/playground/stream');
    expect(call?.[1]?.body).toMatchObject({
      model: 'model-b',
      system: 'be brief',
      prompt: 'second',
      maxTokens: 4096,
      temperature: 0.4,
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
      ],
    });
  });

  it('opens empty without a replay', () => {
    mount();
    expect(screen.queryByTestId('playground-replay')).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>('s2.playground.prompt').value).toBe('');
  });
});
