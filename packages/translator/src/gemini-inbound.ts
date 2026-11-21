/**
 * Gemini inbound ⇄ canonical (card 11.1):
 * `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`.
 *
 * This is the client-facing direction (Gemini CLI → DiRouter). The outbound Gemini adapter lives
 * in `gemini.ts` (canonical → Google API).
 */
import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalTool,
  CanonicalToolChoice,
  CanonicalUsage,
  GeminiGenerateContentRequest,
  GeminiRequestPart,
} from '@dirouter/contracts';

import { type DropReporter, emptyUsage, ignoreDrops, type TranslateOptions } from './common.js';
import { decodeGeminiToolCallId, encodeGeminiToolCallId } from './gemini.js';
import { encodeSse } from './sse.js';

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Gemini pairs a `functionResponse` with its `functionCall` by name and order (newer clients also
 * echo an `id`). Canonical needs explicit ids, so every call gets one: the client's id when
 * present, otherwise `call_<name>_<n>` from a running counter. Clients resend the whole history
 * each turn, so the same call always receives the same id.
 */
class ToolCallLedger {
  #counter = 0;
  /** Calls still waiting for a response, oldest first, per function name. */
  readonly #pending = new Map<string, string[]>();
  /** Client-supplied id → canonical id (which may also carry the thought signature). */
  readonly #byClientId = new Map<string, string>();

  call(name: string, clientId: string | undefined, signature: string | undefined): string {
    const id = encodeGeminiToolCallId(clientId ?? this.#generate(name), signature);
    const queue = this.#pending.get(name) ?? [];
    queue.push(id);
    this.#pending.set(name, queue);
    if (clientId !== undefined) this.#byClientId.set(clientId, id);
    return id;
  }

  response(name: string, clientId: string | undefined): string {
    const queue = this.#pending.get(name) ?? [];
    const known = clientId === undefined ? undefined : this.#byClientId.get(clientId);
    if (known !== undefined && queue.includes(known)) {
      queue.splice(queue.indexOf(known), 1);
      return known;
    }
    // No usable id: responses answer the calls of that name first-in, first-out.
    return queue.shift() ?? clientId ?? this.#generate(name);
  }

  #generate(name: string): string {
    return `call_${name}_${String(this.#counter++)}`;
  }
}

function partToCanonical(
  part: GeminiRequestPart,
  onDrop: DropReporter,
  ledger: ToolCallLedger,
): CanonicalPart[] {
  if (part.functionCall) {
    return [
      {
        type: 'tool_call',
        id: ledger.call(part.functionCall.name, part.functionCall.id, part.thoughtSignature),
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      },
    ];
  }
  if (part.functionResponse) {
    const response = part.functionResponse.response ?? {};
    const content =
      Object.keys(response).length === 1 && typeof response.result === 'string'
        ? response.result
        : JSON.stringify(response);
    return [
      {
        type: 'tool_result',
        toolCallId: ledger.response(part.functionResponse.name, part.functionResponse.id),
        content: [{ type: 'text', text: content }],
      },
    ];
  }
  if (typeof part.text === 'string')
    return part.thought
      ? [{ type: 'reasoning', text: part.text }]
      : [{ type: 'text', text: part.text }];
  if (part.inlineData)
    return [
      {
        type: 'image',
        source: {
          kind: 'base64',
          mediaType: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      },
    ];
  if (part.fileData)
    return [{ type: 'image', source: { kind: 'url', url: part.fileData.fileUri } }];
  onDrop('contents[].parts[]', 'part type not supported by the canonical model');
  return [];
}

const GEMINI_SCHEMA_TYPES = new Set([
  'STRING',
  'NUMBER',
  'INTEGER',
  'BOOLEAN',
  'ARRAY',
  'OBJECT',
  'NULL',
]);

/**
 * `parameters` is a Gemini `Schema` whose type names are upper-case enum values (`OBJECT`,
 * `STRING`); JSON Schema, which canonical tools use, spells them in lower case.
 */
function geminiSchemaToJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (typeof schema.type === 'string' && GEMINI_SCHEMA_TYPES.has(schema.type))
    out.type = schema.type.toLowerCase();
  if (isRecord(schema.properties))
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        isRecord(value) ? geminiSchemaToJsonSchema(value) : value,
      ]),
    );
  if (isRecord(schema.items)) out.items = geminiSchemaToJsonSchema(schema.items);
  if (Array.isArray(schema.anyOf))
    out.anyOf = schema.anyOf.map((value: unknown) =>
      isRecord(value) ? geminiSchemaToJsonSchema(value) : value,
    );
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

export function geminiRequestToCanonical(
  req: GeminiGenerateContentRequest,
  options: TranslateOptions = {},
): CanonicalRequest {
  const onDrop = options.onDrop ?? ignoreDrops;
  const system = (req.systemInstruction?.parts ?? []).flatMap((p) =>
    typeof p.text === 'string' ? [{ type: 'text' as const, text: p.text }] : [],
  );
  const ledger = new ToolCallLedger();
  const messages: CanonicalMessage[] = [];
  for (const content of req.contents) {
    const parts = content.parts.flatMap((p) => partToCanonical(p, onDrop, ledger));
    if (content.role === 'model') {
      messages.push({ role: 'assistant', content: parts });
      continue;
    }
    // In canonical, tool results are separate "tool" messages that come before the rest of the
    // user content (the same representation the Anthropic inbound translator produces).
    const results = parts.filter((p) => p.type === 'tool_result');
    const rest = parts.filter((p) => p.type !== 'tool_result');
    if (results.length > 0) messages.push({ role: 'tool', content: results });
    if (rest.length > 0 || results.length === 0) messages.push({ role: 'user', content: rest });
  }

  const tools: CanonicalTool[] = (req.tools ?? []).flatMap((group) =>
    (group.functionDeclarations ?? []).map((d) => ({
      name: d.name,
      ...(d.description !== undefined ? { description: d.description } : {}),
      parameters:
        d.parametersJsonSchema ??
        (d.parameters
          ? geminiSchemaToJsonSchema(d.parameters)
          : { type: 'object', properties: {} }),
    })),
  );

  const calling = req.toolConfig?.functionCallingConfig;
  const mode = calling?.mode;
  let toolChoice: CanonicalToolChoice | undefined;
  // VALIDATED lets the model answer in text or call a function, like AUTO.
  if (mode === 'AUTO' || mode === 'VALIDATED') toolChoice = 'auto';
  else if (mode === 'NONE') toolChoice = 'none';
  else if (mode === 'ANY') {
    const [only, ...others] = calling?.allowedFunctionNames ?? [];
    toolChoice = only !== undefined && others.length === 0 ? { name: only } : 'required';
    if (others.length > 0)
      onDrop('toolConfig.functionCallingConfig.allowedFunctionNames', 'only one name is supported');
  }

  const gen = req.generationConfig ?? {};
  const mime = gen.responseMimeType;
  const jsonSchema =
    gen.responseJsonSchema ??
    (gen.responseSchema ? geminiSchemaToJsonSchema(gen.responseSchema) : undefined);
  const budget = gen.thinkingConfig?.thinkingBudget;
  const level = gen.thinkingConfig?.thinkingLevel?.toLowerCase();
  const reasoning = {
    // A negative budget asks for a dynamic one, which is the provider default.
    ...(budget !== undefined && budget >= 0 ? { budgetTokens: budget } : {}),
    ...(level !== undefined && THINKING_LEVELS.has(level)
      ? { effort: level as 'minimal' | 'low' | 'medium' | 'high' }
      : {}),
  };
  const responseFormat =
    mime === 'application/json'
      ? jsonSchema
        ? {
            type: 'json_schema' as const,
            name: 'gemini_response',
            schema: jsonSchema,
          }
        : { type: 'json_object' as const }
      : undefined;

  return {
    inboundApi: 'gemini.generate',
    model: options.model ?? '',
    system,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(gen.maxOutputTokens !== undefined ? { maxOutputTokens: gen.maxOutputTokens } : {}),
    ...(gen.temperature !== undefined ? { temperature: gen.temperature } : {}),
    ...(gen.topP !== undefined ? { topP: gen.topP } : {}),
    ...(gen.topK !== undefined ? { topK: gen.topK } : {}),
    ...(gen.stopSequences?.length ? { stop: gen.stopSequences } : {}),
    ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
    stream: req.stream === true,
  };
}

const FINISH_TO_GEMINI: Record<CanonicalFinishReason, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  content_filter: 'SAFETY',
  refusal: 'SAFETY',
  error: 'OTHER',
  other: 'OTHER',
};

export function geminiUsageToMetadata(usage: CanonicalUsage) {
  return {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    thoughtsTokenCount: usage.reasoningTokens,
    cachedContentTokenCount: usage.cacheReadTokens,
    totalTokenCount: usage.inputTokens + usage.outputTokens,
  };
}

export interface GeminiInboundOptions {
  model: string;
  responseId?: string;
}

/**
 * A complete `functionCall` part. The canonical id is echoed as `id` so clients that send it back
 * in `functionResponse.id` keep calls and results paired; a thought signature travelling inside
 * the canonical id is restored as `thoughtSignature`.
 */
function functionCallPart(canonicalId: string, name: string, args: string) {
  const { id, signature } = decodeGeminiToolCallId(canonicalId);
  return {
    functionCall: { id, name, args: safeJson(args) },
    ...(signature ? { thoughtSignature: signature } : {}),
  };
}

function partsOf(response: CanonicalResponse): Record<string, unknown>[] {
  return response.content.flatMap((part): Record<string, unknown>[] => {
    switch (part.type) {
      case 'text':
        return [{ text: part.text }];
      case 'reasoning':
        return [{ text: part.text, thought: true }];
      case 'tool_call':
        return [functionCallPart(part.id, part.name, part.arguments)];
      default:
        return [];
    }
  });
}

export function canonicalToGeminiResponse(response: CanonicalResponse, opts: GeminiInboundOptions) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: partsOf(response) },
        finishReason: FINISH_TO_GEMINI[response.finishReason],
        index: 0,
      },
    ],
    ...(response.usage ? { usageMetadata: geminiUsageToMetadata(response.usage) } : {}),
    modelVersion: opts.model,
    responseId: opts.responseId ?? response.id,
  };
}

/**
 * canonical stream → Gemini SSE chunks (the client SDK accepts one chunk per data line).
 *
 * Gemini has no partial function calls: a `functionCall` part always carries the whole `args`
 * object. Argument deltas are therefore buffered per call and the part is emitted once, when the
 * call ends.
 */
export class GeminiInboundStreamEncoder {
  readonly #model: string;
  #responseId: string | undefined;
  #usage: CanonicalUsage | undefined;
  #finishReason: string | undefined;
  /** Calls whose arguments are still arriving, by canonical content index. */
  readonly #calls = new Map<number, { id: string; name: string; args: string }>();

  constructor(options: { model: string }) {
    this.#model = options.model;
  }

  get usage(): CanonicalUsage | undefined {
    return this.#usage;
  }

  push(event: CanonicalStreamEvent): string {
    switch (event.type) {
      case 'start':
        this.#responseId = event.id;
        return this.#chunk([]);
      case 'text_delta':
        return this.#chunk([{ text: event.text }]);
      case 'reasoning_delta':
        return event.text ? this.#chunk([{ text: event.text, thought: true }]) : '';
      case 'tool_call_start':
        this.#calls.set(event.index, { id: event.id, name: event.name, args: '' });
        return '';
      case 'tool_call_delta': {
        const call = this.#calls.get(event.index);
        if (call) call.args += event.argumentsDelta;
        return '';
      }
      case 'content_end':
        return this.#flush(event.index);
      case 'usage':
        this.#usage = event.usage;
        return '';
      case 'finish':
        this.#finishReason = FINISH_TO_GEMINI[event.finishReason];
        return this.#flush();
      case 'error':
        return encodeSse({
          data: JSON.stringify({
            error: { code: 500, message: event.message, status: 'INTERNAL' },
          }),
        });
      default:
        return '';
    }
  }

  /** Final chunk with finishReason and usage metadata. */
  end(): string {
    const pending = this.#flush();
    const body: Record<string, unknown> = {
      candidates: [
        {
          content: { role: 'model', parts: [] },
          finishReason: this.#finishReason ?? 'STOP',
          index: 0,
        },
      ],
      modelVersion: this.#model,
      ...(this.#responseId ? { responseId: this.#responseId } : {}),
      ...(this.#usage ? { usageMetadata: geminiUsageToMetadata(this.#usage) } : {}),
    };
    return pending + encodeSse({ data: JSON.stringify(body) });
  }

  /** Emits the buffered call at `index`, or every buffered call, as complete parts in one chunk. */
  #flush(index?: number): string {
    const indexes = index === undefined ? [...this.#calls.keys()] : [index];
    const parts: Record<string, unknown>[] = [];
    for (const at of indexes) {
      const call = this.#calls.get(at);
      if (!call) continue;
      this.#calls.delete(at);
      parts.push(functionCallPart(call.id, call.name, call.args));
    }
    return parts.length > 0 ? this.#chunk(parts) : '';
  }

  #chunk(parts: Record<string, unknown>[]): string {
    const body = {
      candidates: [{ content: { role: 'model', parts }, index: 0 }],
      modelVersion: this.#model,
      ...(this.#responseId ? { responseId: this.#responseId } : {}),
    };
    return encodeSse({ data: JSON.stringify(body) });
  }
}

/** `countTokens` for Gemini clients: local estimate, no upstream call. */
export function canonicalUsageForEstimate(inputTokens: number): CanonicalUsage {
  return { ...emptyUsage(), inputTokens };
}
