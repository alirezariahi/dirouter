import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AnthropicErrorBody,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  CONFIG_SNAPSHOT_SCHEMA_VERSION,
  CanonicalRequest,
  ConfigSnapshot,
  ERROR_CODES,
  ErrorCode,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIErrorBody,
  ProblemDetails,
  UsageEvent,
  schemaRegistry,
  toJsonSchema,
  type SchemaName,
} from './index.js';

const fixturesDir = join(import.meta.dirname, '__fixtures__');
const json = (path: string): unknown => JSON.parse(readFileSync(join(fixturesDir, path), 'utf8'));
const jsonl = (path: string): unknown[] =>
  readFileSync(join(fixturesDir, path), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);

describe('OpenAI Chat Completions', () => {
  it('parses a multimodal request with tools and keeps unknown fields', () => {
    const req = OpenAIChatCompletionRequest.parse(json('openai/chat-request-tools.json'));
    expect(req.messages.map((m) => m.role)).toEqual(['developer', 'user', 'assistant', 'tool']);
    expect(req.tools?.[0]?.function.name).toBe('get_weather');
    expect(req).toHaveProperty('prediction');
  });

  it('rejects a request without messages', () => {
    const result = OpenAIChatCompletionRequest.safeParse({ model: 'gpt-4.1', messages: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown message role', () => {
    const result = OpenAIChatCompletionRequest.safeParse({
      model: 'gpt-4.1',
      messages: [{ role: 'robot', content: 'hi' }],
    });
    expect(result.success).toBe(false);
  });

  it('parses a tool-call response', () => {
    const res = OpenAIChatCompletionResponse.parse(json('openai/chat-response-tool-calls.json'));
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
    expect(res.usage?.prompt_tokens_details?.cached_tokens).toBe(0);
  });

  it('parses every chunk of a streamed response', () => {
    const chunks = jsonl('openai/chat-stream.jsonl').map((c) => OpenAIChatCompletionChunk.parse(c));
    expect(chunks).toHaveLength(6);
    expect(chunks.at(-1)?.usage?.total_tokens).toBe(29);
  });

  it('parses an error body', () => {
    const err = OpenAIErrorBody.parse(json('openai/error-invalid-key.json'));
    expect(err.error.code).toBe('invalid_api_key');
  });
});

describe('Anthropic Messages', () => {
  it('parses a request with thinking, tools and server tools', () => {
    const req = AnthropicMessagesRequest.parse(json('anthropic/messages-request-tools.json'));
    expect(req.max_tokens).toBe(1024);
    expect(req.tools).toHaveLength(2);
    expect(req.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('requires max_tokens', () => {
    const result = AnthropicMessagesRequest.safeParse({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.success).toBe(false);
  });

  it('parses a tool_use response with cache usage', () => {
    const res = AnthropicMessagesResponse.parse(json('anthropic/messages-response-tool-use.json'));
    expect(res.stop_reason).toBe('tool_use');
    expect(res.usage.cache_read_input_tokens).toBe(1024);
  });

  it('parses every event of a streamed response', () => {
    const events = jsonl('anthropic/messages-stream.jsonl').map((e) =>
      AnthropicStreamEvent.parse(e),
    );
    expect(events.map((e) => e.type)).toContain('ping');
    expect(events.at(-1)?.type).toBe('message_stop');
  });

  it('parses an error body', () => {
    const err = AnthropicErrorBody.parse(json('anthropic/error-overloaded.json'));
    expect(err.error.type).toBe('overloaded_error');
  });
});

describe('ConfigSnapshot', () => {
  it('parses a full snapshot and applies defaults', () => {
    const snap = ConfigSnapshot.parse(json('dirouter/config-snapshot.json'));
    expect(snap.schemaVersion).toBe(CONFIG_SNAPSHOT_SCHEMA_VERSION);
    expect(snap.version).toBe(42);
    expect(snap.providers[0]?.credentials[1]?.weight).toBe(1);
    expect(snap.settings.defaultRetry.maxAttempts).toBe(2);
  });

  it('rejects a snapshot from an unknown schema version', () => {
    const raw = json('dirouter/config-snapshot.json') as Record<string, unknown>;
    expect(ConfigSnapshot.safeParse({ ...raw, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects a snapshot without version', () => {
    const { version: _version, ...raw } = json('dirouter/config-snapshot.json') as Record<
      string,
      unknown
    >;
    expect(ConfigSnapshot.safeParse(raw).success).toBe(false);
  });

  it('rejects a plaintext provider secret', () => {
    const raw = json('dirouter/config-snapshot.json') as ConfigSnapshot;
    const tampered = structuredClone(raw);
    tampered.providers[0]!.credentials[0]!.secret = 'sk-live-plaintext';
    expect(ConfigSnapshot.safeParse(tampered).success).toBe(false);
  });
});

describe('UsageEvent', () => {
  it('parses an event with a fallback chain', () => {
    const ev = UsageEvent.parse(json('dirouter/usage-event.json'));
    expect(ev.attempts.map((a) => a.outcome)).toEqual(['error', 'success']);
    expect(ev.usage.reasoningTokens).toBe(0);
  });

  it('rejects a fractional cost', () => {
    const raw = json('dirouter/usage-event.json') as Record<string, unknown>;
    expect(UsageEvent.safeParse({ ...raw, costMicros: 1.5 }).success).toBe(false);
  });
});

describe('canonical model', () => {
  it('accepts a minimal request', () => {
    const req = CanonicalRequest.parse({
      inboundApi: 'anthropic.messages',
      model: 'best',
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'سلام' }] }],
      stream: true,
    });
    expect(req.messages[0]?.content[0]).toEqual({ type: 'text', text: 'سلام' });
  });
});

describe('errors', () => {
  it('maps every code to a valid HTTP error status', () => {
    for (const spec of Object.values(ERROR_CODES)) {
      expect(spec.status).toBeGreaterThanOrEqual(400);
      expect(spec.status).toBeLessThan(600);
    }
    expect(ErrorCode.options).toContain('budget_exceeded');
  });

  it('parses problem+json', () => {
    const problem = ProblemDetails.parse({
      type: 'https://dirouter.dev/errors/validation_failed',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      errors: [{ path: 'name', message: 'Required' }],
    });
    expect(problem.code).toBe('validation_failed');
  });
});

describe('JSON Schema export', () => {
  it.each(Object.keys(schemaRegistry) as SchemaName[])('exports %s', (name) => {
    const schema = toJsonSchema(name);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('marks version and schemaVersion as required on ConfigSnapshot', () => {
    const schema = toJsonSchema('config-snapshot') as { required: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['version', 'schemaVersion']));
  });
});
