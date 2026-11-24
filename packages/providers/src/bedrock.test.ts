/**
 * Bedrock and Vertex contract tests (card 11.3): SigV4 signing, Converse mapping, the binary
 * event-stream decoder, and Vertex URL/auth construction.
 */
import { createHash, createHmac } from 'node:crypto';
import { crc32 as zlibCrc32 } from 'node:zlib';

import {
  AnthropicMessagesRequest,
  type CanonicalRequest,
  type CanonicalStreamEvent,
  type ModelConfig,
  type ProviderConfig,
} from '@dirouter/contracts';
import {
  AnthropicStreamEncoder,
  JSON_ONLY_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL,
  UnsupportedContentError,
  anthropicRequestToCanonical,
} from '@dirouter/translator';
import { describe, expect, it } from 'vitest';

import {
  BedrockAdapter,
  EventStreamParser,
  awsCanonicalRequest,
  awsUriEncode,
  canonicalToConverseRequest,
  canonicalUri,
  converseResponseToCanonical,
  crc32,
  parseAwsCredentials,
  signAwsRequest,
} from './bedrock.js';
import { type StreamDecoder, VertexAdapter, maxEmbeddingBatch } from './adapters.js';

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  organizationId: 'o',
  slug: 's',
  type: 'bedrock',
  name: 'n',
  baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  enabled: true,
  options: { region: 'us-east-1' },
  credentials: [],
  ...over,
});

const model = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: 'm',
  organizationId: 'o',
  slug: 'claude',
  providerId: 'p',
  upstreamModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  enabled: true,
  pricing: { inputPerMTok: '3', outputPerMTok: '15' },
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoning: false,
    jsonMode: false,
    embeddings: false,
  },
  ...over,
});

const request = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'claude',
  system: [{ type: 'text', text: 'be brief' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  stream: false,
  ...over,
});

describe('AWS credentials', () => {
  it('accepts the compact and JSON forms', () => {
    expect(parseAwsCredentials('AKIA:secret')).toEqual({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    });
    expect(
      parseAwsCredentials(
        JSON.stringify({ accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' }),
      ),
    ).toEqual({ accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' });
  });

  it('reads a session token from the compact three-part form', () => {
    expect(parseAwsCredentials('ASIA:secret:tok/en+with=chars')).toEqual({
      accessKeyId: 'ASIA',
      secretAccessKey: 'secret',
      sessionToken: 'tok/en+with=chars',
    });
    expect(() => parseAwsCredentials('ASIA::token')).toThrow(/accessKeyId:secretAccessKey/);
  });

  it('rejects malformed credentials', () => {
    expect(() => parseAwsCredentials('no-colon')).toThrow(/accessKeyId:secretAccessKey/);
    expect(() => parseAwsCredentials('{"accessKeyId":"A"}')).toThrow(/need accessKeyId/);
  });
});

describe('SigV4 signing', () => {
  it('adds deterministic SigV4 headers and the session token', () => {
    const input = {
      method: 'POST' as const,
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/claude/converse?beta=1',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      now: new Date('2026-01-02T03:04:05.000Z'),
    };
    const headers = signAwsRequest(input);
    expect(headers['x-amz-date']).toBe('20260102T030405Z');
    expect(headers['x-amz-security-token']).toBe('token');
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA\/20260102\/us-east-1\/bedrock\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/,
    );
    expect(signAwsRequest(input).authorization).toBe(headers.authorization);
    // Temporary credentials: the token header is part of the signature.
    expect(headers.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,',
    );
  });

  it('URI-encodes with the SigV4 unreserved set and uppercase hex', () => {
    expect(awsUriEncode("a b:/*'()!~-._")).toBe('a%20b%3A%2F%2A%27%28%29%21~-._');
    expect(canonicalUri('')).toBe('/');
    expect(canonicalUri('/model/anthropic.claude-v2%3A0/converse')).toBe(
      '/model/anthropic.claude-v2%253A0/converse',
    );
  });

  it('signs the double-encoded path while the request keeps the single-encoded one', () => {
    const body = '{"messages":[]}';
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-v2:0';
    const input = {
      method: 'POST' as const,
      url: `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(arn)}/converse?b=2&a=x%20y`,
      headers: { 'content-type': 'application/json' },
      body,
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2015-08-30T12:36:00.000Z'),
    };
    // Written out by hand from the SigV4 canonical request rules, not derived from the signer.
    const canonical = [
      'POST',
      '/model/arn%253Aaws%253Abedrock%253Aus-east-1%253A123456789012%253Ainference-profile%252Fus.anthropic.claude-v2%253A0/converse',
      'a=x%20y&b=2',
      'content-type:application/json',
      'host:bedrock-runtime.us-east-1.amazonaws.com',
      `x-amz-content-sha256:${bodyHash}`,
      'x-amz-date:20150830T123600Z',
      '',
      'content-type;host;x-amz-content-sha256;x-amz-date',
      bodyHash,
    ].join('\n');
    expect(awsCanonicalRequest(input)).toBe(canonical);

    // Independent signature over that canonical request (plain HMAC chain).
    const mac = (key: Buffer | string, data: string) =>
      createHmac('sha256', key).update(data).digest();
    const scope = '20150830/us-east-1/bedrock/aws4_request';
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    const signingKey = mac(
      mac(mac(mac(`AWS4${input.credentials.secretAccessKey}`, '20150830'), 'us-east-1'), 'bedrock'),
      'aws4_request',
    );
    const signature = mac(signingKey, stringToSign).toString('hex');
    expect(signAwsRequest(input).authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    );
  });
});

describe('canonical → Converse request', () => {
  it('maps system, messages, inference config, tools and tool results', () => {
    const drops: string[] = [];
    const body = canonicalToConverseRequest(
      request({
        maxOutputTokens: 128,
        temperature: 0.2,
        topP: 0.9,
        stop: ['END'],
        toolChoice: 'required',
        tools: [{ name: 'weather', description: 'forecast', parameters: { type: 'object' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{"city":"Tehran"}' },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_1',
                content: [{ type: 'text', text: 'sunny' }],
              },
            ],
          },
        ],
      }),
      'claude',
      (field) => drops.push(field),
    );
    expect(body).toMatchObject({
      modelId: 'claude',
      system: [{ text: 'be brief' }],
      inferenceConfig: {
        maxTokens: 128,
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ['END'],
      },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'weather',
              description: 'forecast',
              inputSchema: { json: { type: 'object' } },
            },
          },
        ],
        toolChoice: { any: {} },
      },
    });
    expect(body.messages).toEqual([
      { role: 'user', content: [{ text: 'weather?' }] },
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'call_1', name: 'weather', input: { city: 'Tehran' } } }],
      },
      {
        role: 'user',
        content: [{ toolResult: { toolUseId: 'call_1', content: [{ text: 'sunny' }] } }],
      },
    ]);
    expect(drops).toEqual([]);
  });

  it('merges consecutive tool results into one user turn', () => {
    const result = (id: string, text: string) => ({
      role: 'tool' as const,
      content: [
        {
          type: 'tool_result' as const,
          toolCallId: id,
          content: [{ type: 'text' as const, text }],
        },
      ],
    });
    const body = canonicalToConverseRequest(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'weather in two cities?' }] },
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id: 'c1', name: 'weather', arguments: '{"city":"Tehran"}' },
              { type: 'tool_call', id: 'c2', name: 'weather', arguments: '{"city":"Shiraz"}' },
            ],
          },
          result('c1', 'sunny'),
          result('c2', 'rain'),
          { role: 'user', content: [{ type: 'text', text: 'and tomorrow?' }] },
        ],
      }),
      'claude',
    );
    const messages = body.messages as { role: string; content: unknown[] }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]?.content).toEqual([
      { toolResult: { toolUseId: 'c1', content: [{ text: 'sunny' }] } },
      { toolResult: { toolUseId: 'c2', content: [{ text: 'rain' }] } },
      { text: 'and tomorrow?' },
    ]);
  });

  it('drops reasoning and image URLs with a report', () => {
    const drops: string[] = [];
    const body = canonicalToConverseRequest(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'reasoning', text: 'ignored' },
              { type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } },
              { type: 'text', text: 'kept' },
            ],
          },
        ],
      }),
      'claude',
      (field) => drops.push(field),
    );
    expect(body.messages).toEqual([{ role: 'user', content: [{ text: 'kept' }] }]);
    expect(drops).toEqual(['messages[].content[]']);
  });

  it('encodes base64 images and tool choice by name', () => {
    const body = canonicalToConverseRequest(
      request({
        toolChoice: { name: 'weather' },
        tools: [{ name: 'weather', parameters: { type: 'object' } }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { kind: 'base64', mediaType: 'image/jpg', data: 'AAAA' },
              },
            ],
          },
        ],
      }),
      'claude',
    );
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ image: { format: 'jpeg', source: { bytes: 'AAAA' } } }],
      },
    ]);
    expect(body.toolConfig).toMatchObject({ toolChoice: { tool: { name: 'weather' } } });
  });
});

describe('Converse response → canonical', () => {
  it('maps text, tool use, finish reason and usage', () => {
    const response = converseResponseToCanonical(
      {
        output: {
          message: {
            content: [
              { text: 'sunny' },
              { toolUse: { toolUseId: 'call_1', name: 'weather', input: { city: 'Tehran' } } },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 1,
        },
      },
      'claude',
    );
    expect(response.finishReason).toBe('tool_calls');
    expect(response.rawFinishReason).toBe('tool_use');
    expect(response.content).toEqual([
      { type: 'text', text: 'sunny' },
      { type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{"city":"Tehran"}' },
    ]);
    // Converse inputTokens excludes the cache; canonical inputTokens is the whole input.
    expect(response.usage).toMatchObject({
      inputTokens: 15,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    });
  });

  it('maps the remaining finish reasons', () => {
    expect(converseResponseToCanonical({ stopReason: 'max_tokens' }).finishReason).toBe('length');
    expect(converseResponseToCanonical({ stopReason: 'content_filtered' }).finishReason).toBe(
      'content_filter',
    );
    expect(converseResponseToCanonical({}).finishReason).toBe('stop');
    expect(converseResponseToCanonical({ stopReason: 'weird' }).finishReason).toBe('other');
  });
});

describe('Bedrock adapter', () => {
  it('signs a Converse request and selects the stream action', () => {
    const adapter = new BedrockAdapter();
    const built = adapter.buildRequest({
      provider: provider(),
      model: model(),
      apiKey: 'AKIA:secret',
      request: request({ stream: true }),
    });
    expect(built.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse-stream',
    );
    expect(built.headers.accept).toBe('application/vnd.amazon.eventstream');
    expect(built.headers.authorization).toContain('AWS4-HMAC-SHA256');
    expect(JSON.parse(built.body ?? '{}')).toMatchObject({ modelId: model().upstreamModel });
  });

  it('sends the session token from provider options when the secret has none', () => {
    const built = new BedrockAdapter().buildRequest({
      provider: provider({ options: { region: 'eu-west-1', sessionToken: 'session' } }),
      model: model(),
      apiKey: 'AKIA:secret',
      request: request(),
    });
    expect(built.url).toContain('bedrock-runtime.us-east-1.amazonaws.com');
    expect(built.headers['x-amz-security-token']).toBe('session');
  });

  it('signs with the session token carried in the credential secret', () => {
    const adapter = new BedrockAdapter();
    const build = (apiKey: string, options: Record<string, unknown> = { region: 'us-east-1' }) =>
      adapter.buildRequest({
        provider: provider({ options }),
        model: model(),
        apiKey,
        request: request(),
      });
    for (const secret of [
      'ASIA:secret:from-secret',
      JSON.stringify({
        accessKeyId: 'ASIA',
        secretAccessKey: 'secret',
        sessionToken: 'from-secret',
      }),
    ]) {
      const built = build(secret);
      expect(built.headers['x-amz-security-token']).toBe('from-secret');
      expect(built.headers.authorization).toContain('x-amz-security-token,');
    }
    // The secret's own token wins over the provider-wide fallback.
    expect(
      build('ASIA:secret:from-secret', { sessionToken: 'fallback' }).headers[
        'x-amz-security-token'
      ],
    ).toBe('from-secret');
    expect(build('AKIA:secret').headers['x-amz-security-token']).toBeUndefined();
    expect(build('AKIA:secret').headers.authorization).not.toContain('x-amz-security-token');
  });

  it('classifies AWS error bodies', () => {
    const adapter = new BedrockAdapter();
    const classify = (body: string, status = 400) =>
      adapter.classifyError({ status, headers: new Headers(), body }).class;
    expect(classify('{"__type":"ThrottlingException"}', 429)).toBe('rate_limit');
    expect(classify('{"__type":"ModelStreamErrorException"}', 500)).toBe('server');
    expect(classify('{"__type":"ValidationException"}')).toBe('bad_request');
    expect(classify('{"__type":"AccessDeniedException"}', 403)).toBe('auth');
    expect(classify('{"__type":"ResourceNotFoundException"}', 404)).toBe('not_found');
    expect(classify('{"__type":"ModelTimeoutException"}', 408)).toBe('timeout');
  });
});

describe('event-stream decoder', () => {
  type HeaderValue = string | { type: number; bytes: Buffer };

  /**
   * Encodes one `vnd.amazon.eventstream` message exactly as AWS puts it on the wire. Checksums
   * come from node:zlib, independently of the CRC implementation under test.
   */
  const frame = (headers: Record<string, HeaderValue>, payload: Buffer | string = ''): Buffer => {
    const headerBytes = Buffer.concat(
      Object.entries(headers).map(([name, value]) => {
        const nameBytes = Buffer.from(name, 'utf8');
        const head = Buffer.concat([Buffer.from([nameBytes.length]), nameBytes]);
        if (typeof value !== 'string')
          return Buffer.concat([head, Buffer.from([value.type]), value.bytes]);
        const valueBytes = Buffer.from(value, 'utf8');
        const length = Buffer.alloc(2);
        length.writeUInt16BE(valueBytes.length);
        return Buffer.concat([head, Buffer.from([7]), length, valueBytes]);
      }),
    );
    const body = Buffer.from(payload);
    const total = 12 + headerBytes.length + body.length + 4;
    const prelude = Buffer.alloc(8);
    prelude.writeUInt32BE(total, 0);
    prelude.writeUInt32BE(headerBytes.length, 4);
    const preludeCrc = Buffer.alloc(4);
    preludeCrc.writeUInt32BE(zlibCrc32(prelude));
    const withoutCrc = Buffer.concat([prelude, preludeCrc, headerBytes, body]);
    const messageCrc = Buffer.alloc(4);
    messageCrc.writeUInt32BE(zlibCrc32(withoutCrc));
    return Buffer.concat([withoutCrc, messageCrc]);
  };

  /** A ConverseStream event: the name is a header, the payload is the bare member. */
  const event = (type: string, payload: unknown): Buffer =>
    frame(
      { ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' },
      JSON.stringify(payload),
    );

  const exception = (type: string, message: string): Buffer =>
    frame(
      {
        ':exception-type': type,
        ':content-type': 'application/json',
        ':message-type': 'exception',
      },
      JSON.stringify({ message }),
    );

  const decoder = (): Required<Pick<StreamDecoder, 'feedChunk' | 'flushChunks'>> &
    StreamDecoder => {
    const created = new BedrockAdapter().createStreamDecoder('claude');
    if (!created.feedChunk || !created.flushChunks) throw new Error('binary decoder expected');
    return created as Required<Pick<StreamDecoder, 'feedChunk' | 'flushChunks'>> & StreamDecoder;
  };

  const errorMessage = (ev: CanonicalStreamEvent | undefined): string =>
    ev?.type === 'error' ? ev.message : '';

  const conversation = (): Buffer =>
    Buffer.concat([
      event('messageStart', { role: 'assistant' }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hel' } }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'lo' } }),
      event('contentBlockStop', { contentBlockIndex: 0 }),
      event('contentBlockStart', {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: 't1', name: 'weather' } },
      }),
      event('contentBlockDelta', {
        contentBlockIndex: 1,
        delta: { toolUse: { input: '{"city"' } },
      }),
      event('contentBlockDelta', {
        contentBlockIndex: 1,
        delta: { toolUse: { input: ':"Tehran"}' } },
      }),
      event('contentBlockStop', { contentBlockIndex: 1 }),
      event('messageStop', { stopReason: 'tool_use' }),
      event('metadata', {
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        metrics: { latencyMs: 12 },
      }),
    ]);

  const expected: Partial<CanonicalStreamEvent>[] = [
    { type: 'start', model: 'claude' },
    { type: 'text_delta', index: 0, text: 'Hel' },
    { type: 'text_delta', index: 0, text: 'lo' },
    { type: 'content_end', index: 0 },
    { type: 'tool_call_start', index: 1, id: 't1', name: 'weather' },
    { type: 'tool_call_delta', index: 1, argumentsDelta: '{"city"' },
    { type: 'tool_call_delta', index: 1, argumentsDelta: ':"Tehran"}' },
    { type: 'content_end', index: 1 },
    { type: 'finish', finishReason: 'tool_calls', rawFinishReason: 'tool_use' },
    {
      type: 'usage',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    },
  ];

  it('computes CRC-32 like zlib', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    const bytes = Buffer.from('event stream éè payload');
    expect(crc32(bytes)).toBe(zlibCrc32(bytes));
  });

  it('dispatches on the :event-type header with frames split across arbitrary chunks', () => {
    const bytes = conversation();
    for (const size of [1, 7, 64, bytes.length]) {
      const stream = decoder();
      const events: CanonicalStreamEvent[] = [];
      for (let i = 0; i < bytes.length; i += size)
        events.push(...stream.feedChunk(bytes.subarray(i, i + size)));
      events.push(...stream.flushChunks());
      expect(events).toHaveLength(expected.length);
      for (const [i, want] of expected.entries()) expect(events[i]).toMatchObject(want);
    }
  });

  it('keeps text and tool blocks on separate indexes for the Anthropic encoder', () => {
    const encoder = new AnthropicStreamEncoder({ model: 'claude' });
    const sse = decoder()
      .feedChunk(conversation())
      .map((ev) => encoder.push(ev))
      .join('');
    expect(sse).toContain('"type":"tool_use","id":"t1","name":"weather"');
    expect(sse).toContain('"partial_json":"{\\"city\\""');
    expect(sse.match(/event: content_block_start/g)).toHaveLength(2);
    expect(sse.match(/event: content_block_stop/g)).toHaveLength(2);
  });

  it('starts lazily and decodes reasoning deltas with their block index', () => {
    const events = decoder().feedChunk(
      Buffer.concat([
        event('contentBlockDelta', {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'thinking' } },
        }),
        event('contentBlockDelta', {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: 'sig' } },
        }),
        event('contentBlockStop', { contentBlockIndex: 0 }),
        event('contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'answer' } }),
        event('somethingNew', { ignored: true }),
      ]),
    );
    expect(events).toMatchObject([
      { type: 'start' },
      { type: 'reasoning_delta', index: 0, text: 'thinking' },
      { type: 'reasoning_delta', index: 0, signature: 'sig' },
      { type: 'content_end', index: 0 },
      { type: 'text_delta', index: 1, text: 'answer' },
    ]);
  });

  it('ignores payloads that only name the event inside the JSON body', () => {
    // The event name must come from the header; a header-less frame carries no event type.
    const stream = decoder();
    expect(
      stream.feedChunk(frame({}, JSON.stringify({ messageStart: { role: 'assistant' } }))),
    ).toEqual([]);
    // An SDK-style wrapped body is tolerated once the header names the event.
    expect(
      stream.feedChunk(
        event('contentBlockDelta', {
          contentBlockDelta: { contentBlockIndex: 2, delta: { text: 'x' } },
        }),
      ),
    ).toMatchObject([{ type: 'start' }, { type: 'text_delta', index: 2, text: 'x' }]);
    expect(stream.push({ event: 'message', data: '{}' })).toEqual([]);
  });

  it.each([
    ['throttlingException', 'rate_limit'],
    ['serviceUnavailableException', 'overloaded'],
    ['modelStreamErrorException', 'server'],
    ['internalServerException', 'server'],
    ['validationException', 'bad_request'],
    ['modelTimeoutException', 'timeout'],
    ['brandNewException', 'server'],
  ])('maps the %s stream exception to an error event with code %s', (type, code) => {
    const stream = decoder();
    const events = stream.feedChunk(
      Buffer.concat([
        event('messageStart', { role: 'assistant' }),
        exception(type, 'something went wrong'),
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'late' } }),
      ]),
    );
    expect(events).toMatchObject([
      { type: 'start' },
      { type: 'error', code, message: `${type}: something went wrong` },
    ]);
    // The stream is over after an exception.
    expect(
      stream.feedChunk(event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'x' } })),
    ).toEqual([]);
    expect(stream.flushChunks()).toEqual([]);
  });

  it('reports unmodelled error messages from their headers', () => {
    const events = decoder().feedChunk(
      frame({
        ':message-type': 'error',
        ':error-code': 'ThrottlingException',
        ':error-message': 'slow down',
      }),
    );
    expect(events).toEqual([
      { type: 'error', code: 'rate_limit', message: 'ThrottlingException: slow down' },
    ]);
  });

  it('turns a checksum mismatch into a single error event', () => {
    const good = event('messageStart', { role: 'assistant' });
    const bad = Buffer.from(
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'x' } }),
    );
    bad.writeUInt8(bad.readUInt8(bad.length - 6) ^ 0xff, bad.length - 6);
    const stream = decoder();
    const events = stream.feedChunk(Buffer.concat([good, bad, good]));
    expect(events).toMatchObject([{ type: 'start' }, { type: 'error', code: 'server' }]);
    expect(errorMessage(events[1])).toMatch(/message checksum/);
    expect(stream.feedChunk(good)).toEqual([]);

    const prelude = Buffer.from(good);
    prelude.writeUInt32BE(prelude.readUInt32BE(0) + 1, 0);
    const [preludeError, ...rest] = decoder().feedChunk(prelude);
    expect(errorMessage(preludeError)).toMatch(/prelude checksum/);
    expect(rest).toEqual([]);
  });

  it('reports a stream that ends in the middle of a frame', () => {
    const bytes = conversation();
    const stream = decoder();
    stream.feedChunk(bytes.subarray(0, bytes.length - 5));
    const flushed = stream.flushChunks();
    expect(flushed).toMatchObject([{ type: 'error', code: 'server' }]);
    expect(errorMessage(flushed[0])).toMatch(/middle of a frame/);
    expect(stream.flushChunks()).toEqual([]);
  });

  it('parses every header value type and keeps string headers', () => {
    const parser = new EventStreamParser();
    const message = frame(
      {
        flag: { type: 0, bytes: Buffer.alloc(0) },
        off: { type: 1, bytes: Buffer.alloc(0) },
        byte: { type: 2, bytes: Buffer.alloc(1) },
        short: { type: 3, bytes: Buffer.alloc(2) },
        int: { type: 4, bytes: Buffer.alloc(4) },
        long: { type: 5, bytes: Buffer.alloc(8) },
        blob: { type: 6, bytes: Buffer.from([0, 3, 1, 2, 3]) },
        time: { type: 8, bytes: Buffer.alloc(8) },
        uuid: { type: 9, bytes: Buffer.alloc(16) },
        ':event-type': 'contentBlockDelta',
      },
      '{}',
    );
    expect(parser.feed(message.subarray(0, 5))).toEqual([]);
    expect(parser.pendingBytes).toBe(5);
    const [parsed] = parser.feed(message.subarray(5));
    expect(parsed?.headers).toEqual({
      flag: 'true',
      off: 'false',
      ':event-type': 'contentBlockDelta',
    });
    expect(Buffer.from(parsed?.payload ?? []).toString()).toBe('{}');
    expect(parser.pendingBytes).toBe(0);

    // Unknown header type: the frame cannot be trusted.
    expect(parser.feed(frame({ odd: { type: 42, bytes: Buffer.alloc(0) } }))).toEqual([]);
    expect(parser.error).toBe('malformed headers');
    expect(parser.feed(message)).toEqual([]);
    parser.reset();
    expect(parser.feed(message)).toHaveLength(1);
  });

  it('accepts the sample response frame published in the AWS event stream guide', () => {
    // Amazon Transcribe developer guide, "Setting up an HTTP/2 stream": `:date` (timestamp) and
    // `:chunk-signature` (byte array) headers with an empty payload.
    const sample = Buffer.from(
      'AAAAUwAAAEP1RHpYBTpkYXRlCAAAAWiXUkMLEDpjaHVuay1zaWduYXR1cmUGACCt6Zy+uymwEK2SrLp/zVBI' +
        '5eGn83jdBwCaRUBJA+eaDafqjqI=',
      'base64',
    );
    const parser = new EventStreamParser();
    const messages = parser.feed(sample);
    expect(parser.error).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.headers).toEqual({});
    expect(messages[0]?.payload).toHaveLength(0);
  });

  it('turns the structured-output fallback tool into text deltas (card 27.1)', () => {
    const d = decoder();
    const events = d.feedChunk(
      Buffer.concat([
        event('messageStart', { role: 'assistant' }),
        event('contentBlockStart', {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 't1', name: STRUCTURED_OUTPUT_TOOL } },
        }),
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"ci' } } }),
        event('contentBlockDelta', {
          contentBlockIndex: 0,
          delta: { toolUse: { input: 'ty":"Tehran","temp":21}' } },
        }),
        event('contentBlockStop', { contentBlockIndex: 0 }),
        event('messageStop', { stopReason: 'tool_use' }),
      ]),
    );
    const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    expect(JSON.parse(text)).toEqual({ city: 'Tehran', temp: 21 });
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'tool_use',
    });
  });
});

describe('structured output on Bedrock (card 27.1)', () => {
  const SCHEMA = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  };
  const withFormat = (over: Partial<CanonicalRequest> = {}) =>
    request({ responseFormat: { type: 'json_schema', name: 'weather', schema: SCHEMA }, ...over });

  it('golden: older Claude models get a forced fallback tool', () => {
    const body = canonicalToConverseRequest(withFormat(), 'anthropic.claude-sonnet-4-5-v1:0');
    expect(body.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: STRUCTURED_OUTPUT_TOOL,
            description:
              'Return the final answer (weather) by calling this tool. Its input is the answer.',
            inputSchema: { json: SCHEMA },
          },
        },
      ],
      toolChoice: { tool: { name: STRUCTURED_OUTPUT_TOOL } },
    });
    expect(body.additionalModelRequestFields).toBeUndefined();
  });

  it('golden: models that reject a forced tool get output_config.format natively', () => {
    const body = canonicalToConverseRequest(withFormat(), 'us.anthropic.claude-opus-5-5-v1:0');
    expect(body.toolConfig).toBeUndefined();
    expect(body.additionalModelRequestFields).toEqual({
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
  });

  it('client tools keep their place and toolChoice becomes any', () => {
    const body = canonicalToConverseRequest(
      withFormat({ tools: [{ name: 'lookup', parameters: { type: 'object' } }] }),
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    );
    const config = body.toolConfig as {
      tools: { toolSpec: { name: string } }[];
      toolChoice: unknown;
    };
    expect(config.tools.map((t) => t.toolSpec.name)).toEqual(['lookup', STRUCTURED_OUTPUT_TOOL]);
    expect(config.toolChoice).toEqual({ any: {} });
  });

  it('json_object on a native model is an instruction in system', () => {
    const body = canonicalToConverseRequest(
      request({ responseFormat: { type: 'json_object' } }),
      'us.anthropic.claude-sonnet-5-5-v1:0',
    );
    expect(body.system).toEqual([{ text: 'be brief' }, { text: JSON_ONLY_INSTRUCTION }]);
  });

  it('the provider option structuredOutput overrides the default', () => {
    const built = new BedrockAdapter().buildRequest({
      provider: provider({ options: { region: 'us-east-1', structuredOutput: 'native' } }),
      model: model(),
      apiKey: 'AKIA:secret',
      request: withFormat(),
    });
    const body = JSON.parse(built.body ?? '{}') as Record<string, unknown>;
    expect(body.additionalModelRequestFields).toBeDefined();
    expect(body.toolConfig).toBeUndefined();
  });

  it('golden: the fallback tool in a Converse response becomes JSON text', () => {
    const response = converseResponseToCanonical({
      output: {
        message: {
          content: [
            {
              toolUse: { toolUseId: 't', name: STRUCTURED_OUTPUT_TOOL, input: { city: 'Tehran' } },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    });
    expect(response.content).toEqual([{ type: 'text', text: '{"city":"Tehran"}' }]);
    expect(response.finishReason).toBe('stop');
  });
});

describe('documents and audio on Bedrock (card 27.2)', () => {
  const withParts = (content: CanonicalRequest['messages'][number]['content']) =>
    request({ messages: [{ role: 'user', content }] });

  it('golden: a PDF and a text document become Converse document blocks', () => {
    const body = canonicalToConverseRequest(
      withParts([
        {
          type: 'document',
          source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
          filename: 'Q3 report (final).v2.pdf',
        },
        { type: 'document', source: { kind: 'text', text: 'hi' }, title: 'notes: draft/1' },
        { type: 'text', text: 'Summarize both' },
      ]),
      'anthropic.claude-sonnet-4-5-v1:0',
    );
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            document: {
              format: 'pdf',
              name: 'Q3 report (final) v2 1',
              source: { bytes: 'JVBERi0=' },
            },
          },
          { document: { format: 'txt', name: 'notes draft 1 2', source: { bytes: 'aGk=' } } },
          { text: 'Summarize both' },
        ],
      },
    ]);
  });

  it.each([
    [
      'a document by URL',
      { type: 'document', source: { kind: 'url', url: 'https://x.test/a.pdf' } },
      /not by URL/,
    ],
    [
      'an unknown format',
      { type: 'document', source: { kind: 'base64', mediaType: 'image/svg+xml', data: 'AA' } },
      /format is not one of/,
    ],
    [
      'audio',
      { type: 'audio', source: { kind: 'base64', mediaType: 'audio/wav', data: 'AA' } },
      /no audio input/,
    ],
  ])('refuses %s with a clear error', (_name, part, message) => {
    const run = () =>
      canonicalToConverseRequest(
        withParts([part as CanonicalRequest['messages'][number]['content'][number]]),
        'm',
      );
    expect(run).toThrow(UnsupportedContentError);
    expect(run).toThrow(message);
  });
});

describe('prompt caching on Bedrock (card 27.3)', () => {
  const CP = { cachePoint: { type: 'default' } };
  const CP_HOUR = { cachePoint: { type: 'default', ttl: '1h' } };
  const anthropicBody = (body: Record<string, unknown>) =>
    anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({ model: 'claude', max_tokens: 100, ...body }),
    );
  const converse = (body: Record<string, unknown>) =>
    canonicalToConverseRequest(anthropicBody(body), 'anthropic.claude-sonnet-4-5-v1:0');
  const ephemeral = { type: 'ephemeral' };

  it('golden: system breakpoints become cachePoint blocks, TTL kept', () => {
    const body = converse({
      system: [
        {
          type: 'text',
          text: 'You are Claude Code.',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
        { type: 'text', text: 'Project notes', cache_control: ephemeral },
        { type: 'text', text: 'Volatile' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.system).toEqual([
      { text: 'You are Claude Code.' },
      CP_HOUR,
      { text: 'Project notes' },
      CP,
      { text: 'Volatile' },
    ]);
  });

  it('golden: a tool breakpoint becomes a cachePoint entry in toolConfig.tools', () => {
    const body = converse({
      tools: [
        { name: 'Read', input_schema: { type: 'object' } },
        { name: 'Edit', input_schema: { type: 'object' }, cache_control: ephemeral },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((body.toolConfig as { tools: unknown[] }).tools).toEqual([
      { toolSpec: { name: 'Read', inputSchema: { json: { type: 'object' } } } },
      { toolSpec: { name: 'Edit', inputSchema: { json: { type: 'object' } } } },
      CP,
    ]);
  });

  it.each([
    ['text', { type: 'text', text: 'long', cache_control: ephemeral }, { text: 'long' }],
    [
      'image',
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBO' },
        cache_control: ephemeral,
      },
      { image: { format: 'png', source: { bytes: 'iVBO' } } },
    ],
    [
      'document',
      {
        type: 'document',
        title: 'spec',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        cache_control: ephemeral,
      },
      { document: { format: 'pdf', name: 'spec 1', source: { bytes: 'JVBERi0=' } } },
    ],
  ])('golden: a %s breakpoint is followed by a cachePoint', (_name, block, converted) => {
    const body = converse({ messages: [{ role: 'user', content: [block] }] });
    expect(body.messages).toEqual([{ role: 'user', content: [converted, CP] }]);
  });

  it('golden: tool_use and tool_result breakpoints', () => {
    const body = converse({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: {}, cache_control: ephemeral },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'body',
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      { role: 'user', content: [{ text: 'read it' }] },
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't1', name: 'Read', input: {} } }, CP],
      },
      {
        role: 'user',
        content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'body' }] } }, CP_HOUR],
      },
    ]);
  });

  it('golden: top-level automatic caching adds a checkpoint after the last message', () => {
    const body = converse({
      cache_control: ephemeral,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }, CP] }]);
    // Not when the request already uses every checkpoint.
    const full = converse({
      cache_control: ephemeral,
      system: [1, 2, 3, 4].map((n) => ({ type: 'text', text: `s${n}`, cache_control: ephemeral })),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(full.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
  });

  it('cache reads and writes reach canonical usage, stream and non-stream', () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2000,
      cacheWriteInputTokens: 0,
    };
    expect(converseResponseToCanonical({ usage }).usage).toEqual({
      inputTokens: 2010,
      outputTokens: 5,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    // An emulator whose inputTokens already includes the cache (total = input + output).
    expect(
      converseResponseToCanonical({ usage: { ...usage, inputTokens: 2010, totalTokens: 2015 } })
        .usage?.inputTokens,
    ).toBe(2010);
  });
});

describe('Vertex adapter', () => {
  const vertexProvider = (over: Record<string, unknown> = {}) =>
    provider({
      type: 'vertex',
      name: 'vertex',
      baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      options: { project: 'my-project', location: 'europe-west4' },
      ...over,
    });

  it('builds the regional generateContent URL with a bearer token', () => {
    const built = new VertexAdapter().buildRequest({
      provider: vertexProvider(),
      model: model({ upstreamModel: 'gemini-2.5-pro' }),
      apiKey: 'ya29.token',
      request: request(),
    });
    expect(built.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-project/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent',
    );
    expect(built.headers.authorization).toBe('Bearer ya29.token');
  });

  it('honours options.apiVersion and lists publisher models', () => {
    const listed = new VertexAdapter().listModelsRequest(
      vertexProvider({ options: { project: 'p', apiVersion: 'v1' } }),
      'ya29.token',
    );
    expect(listed.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models?pageSize=1000',
    );
  });

  it('sends embeddings to :predict with one instance per text', () => {
    const adapter = new VertexAdapter();
    const providerWithKey = vertexProvider({ options: { project: 'p', authMode: 'apiKey' } });
    const embeddings = adapter.buildEmbeddingsRequest({
      provider: providerWithKey,
      model: model({ upstreamModel: 'text-embedding-005' }),
      apiKey: 'goog-key',
      texts: ['one', 'two'],
      dimensions: 256,
    });
    expect(embeddings.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/us-central1/publishers/google/models/text-embedding-005:predict',
    );
    expect(embeddings.headers['x-goog-api-key']).toBe('goog-key');
    expect(JSON.parse(embeddings.body ?? '{}')).toEqual({
      instances: [{ content: 'one' }, { content: 'two' }],
      parameters: { outputDimensionality: 256 },
    });
    const single = adapter.buildEmbeddingsRequest({
      provider: providerWithKey,
      model: model({ upstreamModel: 'text-embedding-005' }),
      apiKey: 'goog-key',
      texts: ['one'],
    });
    expect(single.url).toContain(':predict');
    expect(JSON.parse(single.body ?? '{}')).toEqual({ instances: [{ content: 'one' }] });
  });

  it('parses :predict embeddings and sums the token counts', () => {
    const adapter = new VertexAdapter();
    expect(
      adapter.parseEmbeddingsResponse({
        predictions: [
          { embeddings: { values: [0.1, 0.2], statistics: { token_count: 3, truncated: false } } },
          { embeddings: { values: [0.3, 0.4], statistics: { token_count: 4, truncated: false } } },
        ],
      }),
    ).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { inputTokens: 7 },
    });
    expect(adapter.parseEmbeddingsResponse({ predictions: [{}] })).toEqual({ vectors: [[]] });
    // A Gemini-shaped body is still understood.
    expect(adapter.parseEmbeddingsResponse({ embedding: { values: [1] } })).toEqual({
      vectors: [[1]],
    });
  });

  it('reports the Vertex embeddings batch limits', () => {
    const central = vertexProvider({ options: { project: 'p' } });
    expect(maxEmbeddingBatch(central, 'text-embedding-005')).toBe(250);
    expect(maxEmbeddingBatch(central, 'gemini-embedding-001')).toBe(1);
    expect(maxEmbeddingBatch(vertexProvider(), 'text-embedding-005')).toBe(5);
  });

  it('requires options.project', () => {
    expect(() =>
      new VertexAdapter().buildRequest({
        provider: vertexProvider({ options: {} }),
        model: model(),
        apiKey: 'k',
        request: request(),
      }),
    ).toThrow(/options.project is required/);
  });
});
