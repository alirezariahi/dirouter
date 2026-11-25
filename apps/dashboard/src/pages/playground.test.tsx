/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { applyEvent, emptyColumn, parseSse } from '../lib/playground-stream';
import { login, resetSessionForTests } from '../lib/session';
import { SettingsProvider } from '../settings';
import PlaygroundPage from './playground';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

const MODELS = ['mock/small', 'mock/long', 'mock/claude', 'mock/gemini'];
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  sse('chunk', { choices: [{ index: 0, delta, finish_reason: finish }] });

/** A streamed body, cut at awkward places so events arrive split across reads. */
function streamed(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
      controller.close();
    },
  });
}

type Body = Record<string, unknown>;
function mockApi(answer: (body: Body, index: number) => string) {
  const streams: Body[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Body) : undefined;
      const json = (value: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (path === '/auth/login') return json({ accessToken: 'token' });
      if (path === '/auth/me')
        return json({
          id: 'usr_1',
          email: 'owner@example.com',
          name: 'Owner',
          organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role: 'OWNER' }],
        });
      if (path === '/orgs/org_1/models')
        return json(MODELS.map((slug, i) => ({ id: `mdl_${String(i)}`, slug, enabled: true })));
      if (path === '/orgs/org_1/playground/stream' && body) {
        streams.push(body);
        return Promise.resolve(
          new Response(streamed(answer(body, streams.length - 1)), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      }
      return json({});
    }),
  );
  return streams;
}

async function renderPage() {
  await act(async () => {
    await login('owner@example.com', 'password');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsProvider>
        <PlaygroundPage />
      </SettingsProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'mock/small' });
  fireEvent.change(screen.getByLabelText('Your virtual key'), {
    target: { value: 'dr-abcdefgh-secretsecret' },
  });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'hello' } });
}

const textAnswer = (body: Body, index: number) =>
  sse('meta', {
    status: 200,
    headers: {
      'x-dirouter-model': String(body.model),
      'x-dirouter-provider': 'mock',
      'x-request-id': `req_${String(index)}`,
    },
  }) +
  chunk({ role: 'assistant' }) +
  sse('ttft', { ms: 100 + index }) +
  chunk({ content: 'answer from ' }) +
  chunk({ content: String(body.model) }) +
  chunk({}, 'stop') +
  sse('end', {
    latencyMs: 400 + index,
    ttftMs: 100 + index,
    inputTokens: 10,
    outputTokens: 20,
    estimatedCostUsd: '0.00000500',
  });

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

describe('playground stream helpers', () => {
  it('parses events split across reads and folds tool call deltas', () => {
    const first = parseSse('event: ttft\ndata: {"ms":12}\n\nevent: chunk\ndata: {"choi');
    expect(first.events).toEqual([{ event: 'ttft', data: { ms: 12 } }]);
    const second = parseSse(
      `${first.rest}ces":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\""}}]}}]}\n\n`,
    );
    let column = [...first.events, ...second.events].reduce(applyEvent, emptyColumn('m'));
    column = applyEvent(column, {
      event: 'chunk',
      data: {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }],
      },
    });
    expect(column.ttftMs).toBe(12);
    expect(column.toolCalls).toEqual([{ id: 'c1', name: 'f', arguments: '{"a":1}' }]);
    expect(applyEvent(column, { event: 'end', data: { latencyMs: 5 } }).state).toBe('done');
  });
});

describe('streamed playground (card 25.6)', () => {
  it('compares four models streaming, each with TTFT and its x-dirouter-* headers', async () => {
    const streams = mockApi(textAnswer);
    await renderPage();
    for (const model of MODELS) fireEvent.click(screen.getByRole('button', { name: model }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('playground-text').map((n) => n.textContent)).toEqual(
        MODELS.map((m) => `answer from ${m}`),
      );
    });
    expect(streams.map((s) => s.model)).toEqual(MODELS);
    const columns = screen.getAllByTestId('playground-column');
    expect(columns).toHaveLength(4);
    await waitFor(() => {
      expect(within(columns[3]!).getByTestId('playground-ttft').textContent).toBe('103 ms');
    });
    const headers = within(columns[1]!).getByTestId('playground-headers');
    expect(headers.textContent).toContain('x-dirouter-model');
    expect(headers.textContent).toContain('mock/long');
    expect(headers.textContent).toContain('x-dirouter-provider');
    expect(headers.textContent).toContain('req_1');
    expect(columns[0]!.textContent).toContain('stop');
    expect(columns[0]!.textContent).toContain('$0.000005');
  });

  it('sends tool definitions and shows the tool call', async () => {
    const streams = mockApi(
      () =>
        sse('meta', { status: 200, headers: { 'x-dirouter-model': 'mock/tool' } }) +
        sse('ttft', { ms: 50 }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Tehran"}' } }] }, 'tool_calls') +
        sse('end', { latencyMs: 80, ttftMs: 50, inputTokens: 5, outputTokens: 12 }),
    );
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'mock/small' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert an example' }));
    fireEvent.change(screen.getByLabelText('Tool choice'), { target: { value: 'required' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect((await screen.findByTestId('playground-tool-calls')).textContent).toContain(
      'get_weather({"city":"Tehran"})',
    );
    expect(streams[0]).toMatchObject({
      toolChoice: 'required',
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
  });

  it('attaches an image and sends every parameter a client sends', async () => {
    const streams = mockApi(textAnswer);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'mock/small' }));
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'cat.png', {
      type: 'image/png',
    });
    fireEvent.change(screen.getByLabelText('Attach an image'), { target: { files: [png] } });
    expect((await screen.findByTestId('playground-image-preview')).textContent).toContain(
      'cat.png',
    );
    fireEvent.change(screen.getByLabelText('Max output tokens'), { target: { value: '64' } });
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('Top P'), { target: { value: '0.9' } });
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Response format'), {
      target: { value: 'json_schema' },
    });
    fireEvent.change(screen.getByLabelText('Response JSON Schema'), {
      target: { value: '{"type":"object","required":["ok"]}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });
    expect(streams[0]).toMatchObject({
      model: 'mock/small',
      prompt: 'hello',
      maxTokens: 64,
      temperature: 0.3,
      topP: 0.9,
      reasoningEffort: 'high',
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'response', schema: { type: 'object', required: ['ok'] } },
      },
    });
    expect(String(streams[0]?.image)).toMatch(/^data:image\/png;base64,/);
    expect(streams[0]).not.toHaveProperty('tools');
  });

  it('refuses bad tool JSON locally and shows a gateway refusal in its column', async () => {
    const streams = mockApi(
      () =>
        sse('meta', { status: 429, headers: { 'x-request-id': 'req_x' } }) +
        sse('error', {
          status: 429,
          code: 'budget_exceeded',
          message: 'Monthly key budget exceeded',
        }) +
        sse('end', { latencyMs: 3 }),
    );
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'mock/small' }));
    fireEvent.change(screen.getByLabelText('Tool definitions (JSON, like OpenAI tools)'), {
      target: { value: '[{"type":"function"' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The tool definitions are not valid JSON.',
    );
    expect(streams).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Tool definitions (JSON, like OpenAI tools)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const column = await screen.findByTestId('playground-column');
    await waitFor(() => {
      expect(column.textContent).toContain('budget_exceeded: Monthly key budget exceeded');
    });
    expect(column.textContent).toContain('429');
  });
});
