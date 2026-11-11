/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import { type LogSearch } from '../lib/log-search';
import LogsPage, { safeLogHeaders } from './logs';

const state = vi.hoisted((): { search: LogSearch; navigate: ReturnType<typeof vi.fn> } => ({
  search: {},
  navigate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => state.search,
  useNavigate: () => state.navigate,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../settings', () => ({ useSettings: () => ({ lang: 'en', calendar: 'gregory' }) }));
vi.mock('../lib/session', () => ({
  useSession: () => undefined,
  currentOrg: () => ({ id: 'org_1' }),
}));
vi.mock(import('../lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  api: vi.fn(),
}));
const row = {
  id: 'req_1',
  createdAt: '2026-01-01T01:00:00Z',
  requestedModel: 'smart',
  projectId: 'proj_1',
  apiKeyId: 'key_1',
  providerId: 'prv_2',
  modelId: 'mdl_2',
  status: 'success',
  httpStatus: 200,
  errorCode: null,
  inputTokens: 100,
  outputTokens: 25,
  costUsd: '0.00123456',
  latencyMs: 320,
  ttftMs: 42,
  usageEstimated: false,
  stream: true,
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LogsPage />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.search = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' };
  state.navigate.mockReset();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((path) =>
    Promise.resolve(
      path.includes('/logs/req_1')
        ? {
            ...row,
            cacheReadTokens: 10,
            cacheWriteTokens: 3,
            reasoningTokens: 7,
            attempts: [
              {
                providerId: 'prv_1',
                modelId: 'mdl_1',
                outcome: 'rate_limited',
                httpStatus: 429,
                errorCode: 'rate_limit',
                latencyMs: 20,
                startedAt: '2026-01-01T01:00:00Z',
                credentialId: 'secret-credential',
                headers: { authorization: 'Bearer secret' },
              },
              {
                providerId: 'prv_2',
                modelId: 'mdl_2',
                outcome: 'success',
                httpStatus: 200,
                latencyMs: 300,
              },
            ],
            headers: {
              'x-request-id': 'upstream-123',
              authorization: 'Bearer secret',
              'set-cookie': 'session=secret',
            },
          }
        : { items: [row], nextCursor: null },
    ),
  );
});
afterEach(cleanup);

describe('Request Log Explorer', () => {
  it('loads shareable filters and applies editable identity, status, latency and cost bounds', async () => {
    state.search = { ...state.search, model: 'smart', minLatencyMs: 0 };
    mount();
    await screen.findByText('smart');
    expect(screen.getByLabelText<HTMLInputElement>('logs.filter.model').value).toBe('smart');
    for (const [key, value] of Object.entries({
      apiKeyId: 'key_2',
      projectId: 'proj_2',
      providerId: 'prv_2',
      status: 'error',
      minLatencyMs: '0',
      maxLatencyMs: '1000',
      minCostUsd: '0',
      maxCostUsd: '0.5',
    })) {
      fireEvent.change(screen.getByLabelText(`logs.filter.${key}`), { target: { value } });
    }
    fireEvent.click(screen.getByText('Apply filters'));
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/logs',
      search: {
        ...state.search,
        apiKeyId: 'key_2',
        projectId: 'proj_2',
        providerId: 'prv_2',
        status: 'error',
        minLatencyMs: 0,
        maxLatencyMs: 1000,
        minCostUsd: '0',
        maxCostUsd: '0.5',
      },
    });
    const path = vi.mocked(api).mock.calls[0]?.[0] ?? '';
    expect(new URL(path, 'https://example.test').searchParams.get('minLatencyMs')).toBe('0');
  });

  it('rejects inverted ranges without navigating', () => {
    mount();
    fireEvent.change(screen.getByLabelText('logs.filter.minLatencyMs'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('logs.filter.maxLatencyMs'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByText('Apply filters'));
    expect(screen.getByRole('alert').textContent).toContain('minimum');
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('opens keyboard-accessible detail with ordered fallback attempts, usage and only safe headers', async () => {
    mount();
    fireEvent.keyDown(await screen.findByTestId('log-row'), { key: 'Enter' });
    const detail = await screen.findByRole('region', { name: 'Request detail' });
    await within(detail).findByText('rate_limit');
    expect(
      within(detail)
        .getAllByTestId('log-attempt')
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining('rate_limited'), expect.stringContaining('success')]);
    expect(within(detail).getByText('0.00123456')).toBeTruthy();
    expect(within(detail).getByText('42')).toBeTruthy();
    expect(within(detail).getByText('Cache read tokens')).toBeTruthy();
    expect(within(detail).getByText('Reasoning tokens')).toBeTruthy();
    expect(within(detail).getByText('upstream-123')).toBeTruthy();
    expect(detail.textContent).not.toContain('secret');
    fireEvent.click(within(detail).getByText('Close detail'));
    expect(screen.queryByRole('region', { name: 'Request detail' })).toBeNull();
  });

  it('handles empty and error detail responses with retry', async () => {
    vi.mocked(api).mockImplementation((path) =>
      path.includes('/logs/req_1')
        ? Promise.reject(new Error('detail unavailable'))
        : Promise.resolve({ items: [row], nextCursor: null }),
    );
    mount();
    fireEvent.click(await screen.findByTestId('log-row'));
    await screen.findByText('detail unavailable');
    vi.mocked(api).mockResolvedValue({
      ...row,
      attempts: [],
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    fireEvent.click(screen.getByText('state.retry'));
    await screen.findByText('No attempts recorded.');
    expect(screen.getByText(/No safe headers recorded/)).toBeTruthy();
  });

  it('paginates using the opaque cursor and preserves filters', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ items: [row], nextCursor: 'opaque+/=' })
      .mockResolvedValueOnce({ items: [{ ...row, id: 'req_2' }], nextCursor: null });
    state.search = { ...state.search, providerId: 'prv_2' };
    mount();
    fireEvent.click(await screen.findByText('logs.more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('log-row')).toHaveLength(2);
    });
    const path = vi.mocked(api).mock.calls[1]?.[0] ?? '';
    const params = new URL(path, 'https://example.test').searchParams;
    expect(params.get('cursor')).toBe('opaque+/=');
    expect(params.get('providerId')).toBe('prv_2');
  });

  it('never admits arbitrary or non-scalar header values', () => {
    expect(
      safeLogHeaders({
        authorization: 'secret',
        cookie: 'secret',
        'content-type': 'application/json',
        'x-request-id': { secret: true },
      }),
    ).toEqual([['content-type', 'application/json']]);
  });
});
