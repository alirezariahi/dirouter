/** @vitest-environment jsdom */
/** Live view over SSE with polling fallback (card 24.4). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, apiEventStream } from '../lib/api';
import { mergeLive, sseParser, type LiveRow } from '../lib/live-stream';
import LivePage from './live';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../settings', () => ({ useSettings: () => ({ lang: 'en', calendar: 'gregory' }) }));
vi.mock('../lib/session', () => ({ currentOrg: () => ({ id: 'org_1' }) }));
vi.mock(import('../lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  api: vi.fn(),
  apiEventStream: vi.fn(),
}));

const row = (id: string, model: string, ageMs = 0): LiveRow => ({
  id,
  createdAt: new Date(Date.now() - ageMs).toISOString(),
  requestedModel: model,
  providerId: 'prv',
  status: 'success',
  httpStatus: 200,
  errorCode: null,
  inputTokens: 1,
  outputTokens: 2,
  costUsd: '0.0001',
  latencyMs: 30,
  stream: false,
});

/** A controllable SSE response body. */
function sseResponse() {
  let push: (text: string) => void = () => undefined;
  let end: () => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (text) => {
        controller.enqueue(encoder.encode(text));
      };
      end = () => {
        controller.close();
      };
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push: (t: string) => {
      push(t);
    },
    end: () => {
      end();
    },
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LivePage />
    </QueryClientProvider>,
  );
}

let polls = 0;
beforeEach(() => {
  polls = 0;
  vi.mocked(api).mockReset();
  vi.mocked(apiEventStream).mockReset();
  vi.mocked(api).mockImplementation(() => {
    polls += 1;
    return Promise.resolve({
      generatedAt: new Date().toISOString(),
      recent: { items: [row('req_old', 'polled-model', 60_000)], nextCursor: null },
      health: { providers: [] },
    });
  });
});
afterEach(cleanup);

describe('live stream helpers', () => {
  it('parses SSE frames across chunks and skips keep-alives', () => {
    const frames: [string, string][] = [];
    const feed = sseParser((event, data) => frames.push([event, data]));
    feed('retry: 3000\n\nevent: ready\ndata: {}\n\n: keep-alive\n\nevent: req');
    feed('uest\ndata: {"id":"a"}\n\n');
    expect(frames).toEqual([
      ['ready', '{}'],
      ['request', '{"id":"a"}'],
    ]);
  });

  it('merges pushed rows into the poll, newest first, once per id, last 15 minutes', () => {
    const now = Date.now();
    const merged = mergeLive(
      [row('a', 'x', 5_000), row('old', 'x', 20 * 60_000)],
      [row('b', 'y', 1_000), row('a', 'x', 5_000)],
      now,
    );
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('Live page', () => {
  it('shows a pushed request at once and polls only slowly while the stream is up', async () => {
    const sse = sseResponse();
    vi.mocked(apiEventStream).mockResolvedValue(sse.response);
    mount();
    await screen.findByText('polled-model');
    sse.push('event: ready\ndata: {}\n\n');
    await waitFor(() => {
      expect(screen.getByTestId('live-mode').dataset.mode).toBe('stream');
    });
    const pushedAt = Date.now();
    sse.push(`event: request\ndata: ${JSON.stringify(row('req_new', 'pushed-model'))}\n\n`);
    await screen.findByText('pushed-model');
    expect(Date.now() - pushedAt).toBeLessThan(2_000);
    const before = polls;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(polls).toBe(before);
    expect(vi.mocked(apiEventStream).mock.calls[0]?.[0]).toBe('/orgs/org_1/stats/live/stream');
  });

  it('falls back to polling every second when the stream drops', async () => {
    const sse = sseResponse();
    vi.mocked(apiEventStream)
      .mockResolvedValueOnce(sse.response)
      .mockReturnValue(new Promise<Response>(() => undefined));
    mount();
    await screen.findByText('polled-model');
    sse.push('event: ready\ndata: {}\n\n');
    await waitFor(() => {
      expect(screen.getByTestId('live-mode').dataset.mode).toBe('stream');
    });
    sse.end();
    await waitFor(() => {
      expect(screen.getByTestId('live-mode').dataset.mode).toBe('polling');
    });
    const before = polls;
    await waitFor(
      () => {
        expect(polls).toBeGreaterThanOrEqual(before + 2);
      },
      { timeout: 4_000 },
    );
    // It tries to reconnect meanwhile.
    await waitFor(() => {
      expect(vi.mocked(apiEventStream).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('polls when the stream cannot be opened at all', async () => {
    vi.mocked(apiEventStream).mockRejectedValue(new Error('503'));
    mount();
    await waitFor(() => {
      expect(screen.getByTestId('live-mode').dataset.mode).toBe('polling');
    });
    await screen.findByText('polled-model');
  });
});
