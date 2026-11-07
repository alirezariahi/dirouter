/**
 * ترجمهٔ stream: chunkهای provider → رویدادهای canonical → رویدادهای API کلاینت.
 *
 * هر مبدل stateful است ولی حافظه‌اش با طول stream رشد نمی‌کند (فقط شاخص‌ها و
 * وضعیت بلوک باز نگه داشته می‌شود، نه متن).
 */
import type {
  AnthropicStreamEvent,
  CanonicalFinishReason,
  CanonicalStreamEvent,
  CanonicalUsage,
  OpenAIChatCompletionChunk,
} from '@dirouter/contracts';

import {
  anthropicBlockToCanonical,
  anthropicStopToCanonical,
  canonicalUsageToAnthropic,
  FINISH_TO_ANTHROPIC,
} from './anthropic.js';
import { emptyUsage } from './common.js';
import {
  canonicalUsageToOpenAI,
  FINISH_TO_OPENAI,
  openAIFinishToCanonical,
  openAIUsageToCanonical,
} from './openai.js';
import { encodeSse } from './sse.js';

// ───────────── OpenAI chunks → canonical ─────────────

export class OpenAIStreamDecoder {
  #started = false;
  #nextIndex = 0;
  #textIndex: number | undefined;
  #reasoningIndex: number | undefined;
  /** شاخص tool call در OpenAI → شاخص بلوک canonical */
  readonly #tools = new Map<number, number>();
  #open = new Set<number>();
  #finished = false;

  push(chunk: OpenAIChatCompletionChunk): CanonicalStreamEvent[] {
    const out: CanonicalStreamEvent[] = [];
    if (!this.#started) {
      this.#started = true;
      out.push({ type: 'start', id: chunk.id, model: chunk.model, created: chunk.created });
    }
    const choice = chunk.choices[0];
    if (choice) {
      const delta = choice.delta as typeof choice.delta & { reasoning_content?: string | null };
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        this.#reasoningIndex ??= this.#allocate();
        out.push({
          type: 'reasoning_delta',
          index: this.#reasoningIndex,
          text: delta.reasoning_content,
        });
      }
      const text = (delta.content ?? '') + (delta.refusal ?? '');
      if (text !== '') {
        this.#textIndex ??= this.#allocate();
        out.push({ type: 'text_delta', index: this.#textIndex, text });
      }
      for (const call of delta.tool_calls ?? []) {
        let index = this.#tools.get(call.index);
        if (index === undefined) {
          index = this.#allocate();
          this.#tools.set(call.index, index);
          out.push({
            type: 'tool_call_start',
            index,
            id: call.id ?? `call_${index}`,
            name: call.function?.name ?? '',
          });
        }
        const args = call.function?.arguments;
        if (args) out.push({ type: 'tool_call_delta', index, argumentsDelta: args });
      }
      if (choice.finish_reason && !this.#finished) {
        this.#finished = true;
        for (const index of this.#open) out.push({ type: 'content_end', index });
        this.#open.clear();
        out.push({
          type: 'finish',
          finishReason: delta.refusal ? 'refusal' : openAIFinishToCanonical(choice.finish_reason),
          rawFinishReason: choice.finish_reason,
        });
      }
    }
    if (chunk.usage) out.push({ type: 'usage', usage: openAIUsageToCanonical(chunk.usage) });
    return out;
  }

  #allocate(): number {
    const index = this.#nextIndex++;
    this.#open.add(index);
    return index;
  }
}

// ───────────── Anthropic events → canonical ─────────────

export class AnthropicStreamDecoder {
  #usage: CanonicalUsage = emptyUsage();
  #inputRaw = 0;

  push(event: AnthropicStreamEvent): CanonicalStreamEvent[] {
    switch (event.type) {
      case 'message_start': {
        const u = event.message.usage;
        this.#inputRaw = u.input_tokens;
        this.#usage = {
          ...emptyUsage(),
          inputTokens:
            u.input_tokens +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          outputTokens: u.output_tokens,
        };
        return [
          {
            type: 'start',
            id: event.message.id,
            model: event.message.model,
            created: Math.floor(Date.now() / 1000),
          },
        ];
      }
      case 'content_block_start': {
        const part = anthropicBlockToCanonical(event.content_block);
        if (part?.type === 'tool_call')
          return [{ type: 'tool_call_start', index: event.index, id: part.id, name: part.name }];
        if (part?.type === 'text' && part.text !== '')
          return [{ type: 'text_delta', index: event.index, text: part.text }];
        return [];
      }
      case 'content_block_delta': {
        const d = event.delta;
        switch (d.type) {
          case 'text_delta':
            return [{ type: 'text_delta', index: event.index, text: d.text }];
          case 'input_json_delta':
            return d.partial_json === ''
              ? []
              : [{ type: 'tool_call_delta', index: event.index, argumentsDelta: d.partial_json }];
          case 'thinking_delta':
            return [{ type: 'reasoning_delta', index: event.index, text: d.thinking }];
          case 'signature_delta':
            return [{ type: 'reasoning_delta', index: event.index, signature: d.signature }];
          default:
            return [];
        }
      }
      case 'content_block_stop':
        return [{ type: 'content_end', index: event.index }];
      case 'message_delta': {
        const u = event.usage;
        // بعضی providerها usage کامل را در message_delta می‌دهند.
        if (u.input_tokens !== null && u.input_tokens !== undefined)
          this.#inputRaw = u.input_tokens;
        const cacheRead = u.cache_read_input_tokens ?? this.#usage.cacheReadTokens;
        const cacheWrite = u.cache_creation_input_tokens ?? this.#usage.cacheWriteTokens;
        this.#usage = {
          ...this.#usage,
          inputTokens: this.#inputRaw + cacheRead + cacheWrite,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          outputTokens: u.output_tokens,
        };
        const out: CanonicalStreamEvent[] = [{ type: 'usage', usage: this.#usage }];
        if (event.delta.stop_reason) {
          out.push({
            type: 'finish',
            finishReason: anthropicStopToCanonical(event.delta.stop_reason),
            rawFinishReason: event.delta.stop_reason,
          });
        }
        return out;
      }
      case 'error':
        return [{ type: 'error', code: event.error.type, message: event.error.message }];
      default:
        return [];
    }
  }
}

// ───────────── canonical → OpenAI SSE ─────────────

const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'timeout_error',
  'api_error',
  'overloaded_error',
]);

/** کد خطای canonical (کلاس DiRouter یا نوع upstream) → نوع استاندارد خطای Anthropic. */
export function anthropicErrorType(code: string): string {
  if (ANTHROPIC_ERROR_TYPES.has(code)) return code;
  if (/overload/i.test(code)) return 'overloaded_error';
  if (/rate_limit|RESOURCE_EXHAUSTED/i.test(code)) return 'rate_limit_error';
  if (/timeout|DEADLINE/i.test(code)) return 'timeout_error';
  return 'api_error';
}

export interface StreamEncoderOptions {
  /** نام مدلی که کلاینت فرستاده (در پاسخ همان برمی‌گردد). */
  model: string;
}

/**
 * canonical → chunkهای OpenAI. `includeUsage` همان `stream_options.include_usage`
 * کلاینت است؛ usage همیشه از upstream گرفته می‌شود ولی فقط در صورت درخواست ارسال می‌شود.
 */
export class OpenAIStreamEncoder {
  readonly #model: string;
  readonly #includeUsage: boolean;
  #id = 'chatcmpl-dirouter';
  #created = Math.floor(Date.now() / 1000);
  #started = false;
  readonly #toolOrdinal = new Map<number, number>();
  #usage: CanonicalUsage | undefined;
  #finished = false;

  constructor(options: StreamEncoderOptions & { includeUsage: boolean }) {
    this.#model = options.model;
    this.#includeUsage = options.includeUsage;
  }

  get usage(): CanonicalUsage | undefined {
    return this.#usage;
  }

  /** رویداد canonical → متن SSE (ممکن است خالی باشد). */
  push(event: CanonicalStreamEvent): string {
    switch (event.type) {
      case 'start':
        this.#id = event.id.startsWith('chatcmpl-') ? event.id : `chatcmpl-${event.id}`;
        this.#created = event.created;
        return this.#ensureStarted();
      case 'text_delta':
        return this.#ensureStarted() + this.#chunk({ content: event.text });
      case 'tool_call_start': {
        const ordinal = this.#toolOrdinal.size;
        this.#toolOrdinal.set(event.index, ordinal);
        return (
          this.#ensureStarted() +
          this.#chunk({
            tool_calls: [
              {
                index: ordinal,
                id: event.id,
                type: 'function',
                function: { name: event.name, arguments: '' },
              },
            ],
          })
        );
      }
      case 'tool_call_delta': {
        const ordinal = this.#toolOrdinal.get(event.index);
        if (ordinal === undefined) return '';
        return this.#chunk({
          tool_calls: [{ index: ordinal, function: { arguments: event.argumentsDelta } }],
        });
      }
      case 'usage':
        this.#usage = event.usage;
        return '';
      case 'finish':
        if (this.#finished) return '';
        this.#finished = true;
        return this.#ensureStarted() + this.#chunk({}, FINISH_TO_OPENAI[event.finishReason]);
      case 'error':
        return encodeSse({
          data: JSON.stringify({
            error: { message: event.message, type: 'api_error', param: null, code: event.code },
          }),
        });
      case 'reasoning_delta':
      case 'content_end':
        return '';
    }
  }

  /** پایان stream: usage (در صورت درخواست) و `[DONE]`. */
  end(): string {
    let out = '';
    if (!this.#finished) out += this.push({ type: 'finish', finishReason: 'stop' });
    if (this.#includeUsage) {
      out += encodeSse({
        data: JSON.stringify({
          id: this.#id,
          object: 'chat.completion.chunk',
          created: this.#created,
          model: this.#model,
          choices: [],
          usage: canonicalUsageToOpenAI(this.#usage ?? emptyUsage()),
        }),
      });
    }
    return `${out}data: [DONE]\n\n`;
  }

  #ensureStarted(): string {
    if (this.#started) return '';
    this.#started = true;
    return this.#chunk({ role: 'assistant', content: '' });
  }

  #chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return encodeSse({
      data: JSON.stringify({
        id: this.#id,
        object: 'chat.completion.chunk',
        created: this.#created,
        model: this.#model,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
        ...(this.#includeUsage ? { usage: null } : {}),
      }),
    });
  }
}

// ───────────── canonical → Anthropic SSE ─────────────

type OpenBlock = { canonical: number; anthropic: number; kind: 'text' | 'tool' | 'thinking' };

export class AnthropicStreamEncoder {
  readonly #model: string;
  #id = 'msg_dirouter';
  #started = false;
  #nextIndex = 0;
  #open: OpenBlock | undefined;
  /** بلوک‌های canonical که بسته شدند؛ deltaهای دیررس آن‌ها نادیده گرفته می‌شوند. */
  readonly #closed = new Set<number>();
  #usage: CanonicalUsage | undefined;
  #finish: CanonicalFinishReason | undefined;

  constructor(options: StreamEncoderOptions) {
    this.#model = options.model;
  }

  get usage(): CanonicalUsage | undefined {
    return this.#usage;
  }

  push(event: CanonicalStreamEvent): string {
    switch (event.type) {
      case 'start':
        this.#id = event.id.startsWith('msg_') ? event.id : `msg_${event.id}`;
        return this.#ensureStarted();
      case 'text_delta':
        return (
          this.#ensureStarted() +
          this.#block(event.index, 'text', { type: 'text', text: '' }) +
          this.#delta({ type: 'text_delta', text: event.text })
        );
      case 'reasoning_delta': {
        let out =
          this.#ensureStarted() +
          this.#block(event.index, 'thinking', { type: 'thinking', thinking: '', signature: '' });
        if (event.text) out += this.#delta({ type: 'thinking_delta', thinking: event.text });
        if (event.signature)
          out += this.#delta({ type: 'signature_delta', signature: event.signature });
        return out;
      }
      case 'tool_call_start':
        return (
          this.#ensureStarted() +
          this.#block(event.index, 'tool', {
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: {},
          })
        );
      case 'tool_call_delta':
        if (this.#open?.canonical !== event.index) return '';
        return this.#delta({ type: 'input_json_delta', partial_json: event.argumentsDelta });
      case 'content_end':
        return this.#open?.canonical === event.index ? this.#closeOpen() : '';
      case 'usage':
        this.#usage = event.usage;
        return '';
      case 'finish':
        this.#finish ??= event.finishReason;
        return this.#closeOpen();
      case 'error':
        return encodeSse({
          event: 'error',
          data: JSON.stringify({
            type: 'error',
            error: { type: anthropicErrorType(event.code), message: event.message },
          }),
        });
    }
  }

  /** پایان stream: بستن بلوک باز، message_delta با usage نهایی و message_stop. */
  end(): string {
    let out = this.#ensureStarted() + this.#closeOpen();
    const usage = canonicalUsageToAnthropic(this.#usage ?? emptyUsage());
    out += this.#event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: FINISH_TO_ANTHROPIC[this.#finish ?? 'stop'], stop_sequence: null },
      usage,
    });
    out += this.#event('message_stop', { type: 'message_stop' });
    return out;
  }

  /** رویداد ping دوره‌ای Anthropic. */
  ping(): string {
    return this.#event('ping', { type: 'ping' });
  }

  #ensureStarted(): string {
    if (this.#started) return '';
    this.#started = true;
    return this.#event('message_start', {
      type: 'message_start',
      message: {
        id: this.#id,
        type: 'message',
        role: 'assistant',
        model: this.#model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // usage ورودی در OpenAI تا آخر stream معلوم نیست؛ مقدار نهایی در message_delta می‌آید.
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  #block(
    canonical: number,
    kind: OpenBlock['kind'],
    contentBlock: Record<string, unknown>,
  ): string {
    if (this.#open?.canonical === canonical) return '';
    if (this.#closed.has(canonical)) return '';
    const out = this.#closeOpen();
    this.#open = { canonical, anthropic: this.#nextIndex++, kind };
    return (
      out +
      this.#event('content_block_start', {
        type: 'content_block_start',
        index: this.#open.anthropic,
        content_block: contentBlock,
      })
    );
  }

  #delta(delta: Record<string, unknown>): string {
    if (!this.#open) return '';
    return this.#event('content_block_delta', {
      type: 'content_block_delta',
      index: this.#open.anthropic,
      delta,
    });
  }

  #closeOpen(): string {
    if (!this.#open) return '';
    const { anthropic, canonical } = this.#open;
    this.#open = undefined;
    this.#closed.add(canonical);
    return this.#event('content_block_stop', { type: 'content_block_stop', index: anthropic });
  }

  #event(name: string, data: unknown): string {
    return encodeSse({ event: name, data: JSON.stringify(data) });
  }
}
