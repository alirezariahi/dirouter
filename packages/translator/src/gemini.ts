/**
 * canonical ⇄ Gemini `generateContent` / `streamGenerateContent` (کارت ۴.۸).
 *
 * Gemini فقط مقصد است (ورودی Gemini نداریم)، پس این فایل یک‌طرفه است:
 * canonical → درخواست Gemini، و پاسخ/stream Gemini → canonical.
 *
 * نکته‌ها:
 * - نقش‌ها `user` و `model` هستند و پیام‌های هم‌نقش پشت‌سرهم ادغام می‌شوند.
 * - functionResponse نام تابع را می‌خواهد؛ از tool_call هم‌شناسه در تاریخچه پیدا می‌شود.
 * - Gemini 3 روی functionCall امضای thought (`thoughtSignature`) می‌گذارد و باید در نوبت
 *   بعد عیناً برگردد. canonical جایی برای آن ندارد، پس داخل شناسهٔ tool call جاسازی
 *   می‌شود (`<id>__ts__<signature>`) که کلاینت‌های OpenAI و Anthropic دست‌نخورده برمی‌گردانند.
 * - اسکیمای ابزار Gemini زیرمجموعهٔ OpenAPI است؛ کلیدهای ناشناخته (`$schema`،
 *   `additionalProperties`، …) حذف می‌شوند.
 */
import type {
  CanonicalFinishReason,
  CanonicalImagePart,
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalUsage,
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiUsageMetadata,
} from '@dirouter/contracts';

import {
  type DropReporter,
  ignoreDrops,
  parseToolArguments,
  type TranslateOptions,
} from './common.js';

type Json = Record<string, unknown>;

// ───────────── شناسهٔ tool call و امضای thought ─────────────

const SIGNATURE_SEP = '__ts__';
/** امضای جایگزین مستند Google برای functionCallی که امضا ندارد (مثلاً از مدل دیگر آمده). */
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

export function encodeGeminiToolCallId(id: string, signature: string | undefined): string {
  return signature ? `${id}${SIGNATURE_SEP}${signature}` : id;
}

export function decodeGeminiToolCallId(id: string): { id: string; signature?: string } {
  const at = id.indexOf(SIGNATURE_SEP);
  if (at < 0) return { id };
  return { id: id.slice(0, at), signature: id.slice(at + SIGNATURE_SEP.length) };
}

// ───────────── اسکیمای ابزار ─────────────

const SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
]);

/**
 * JSON Schema → زیرمجموعهٔ OpenAPI که Gemini می‌پذیرد. `type: ["string","null"]` به
 * `type: "string", nullable: true` و `const` به `enum` تبدیل می‌شود؛ `oneOf` مثل `anyOf`.
 */
export function toGeminiSchema(schema: unknown, onDrop: DropReporter = ignoreDrops): unknown {
  if (Array.isArray(schema)) return schema.map((s) => toGeminiSchema(s, onDrop));
  if (!schema || typeof schema !== 'object') return schema;
  const input = schema as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t) => t !== 'null');
      if (types.length !== value.length) out.nullable = true;
      if (types.length === 1) out.type = types[0];
      else if (types.length > 1) out.anyOf = types.map((t: unknown) => ({ type: t }));
    } else if (key === 'const') {
      out.enum = [value];
    } else if (key === 'oneOf') {
      out.anyOf = toGeminiSchema(value, onDrop);
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Json).map(([k, v]) => [k, toGeminiSchema(v, onDrop)]),
      );
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = toGeminiSchema(value, onDrop);
    } else if (SCHEMA_KEYS.has(key)) {
      out[key] = value;
    } else {
      onDrop(`tools[].parameters.${key}`, 'not supported by Gemini schema');
    }
  }
  // Gemini فقط enum رشته‌ای می‌پذیرد.
  if (Array.isArray(out.enum)) {
    out.enum = out.enum.map(String);
    out.type ??= 'string';
  }
  // شیء بدون property برای Gemini نامعتبر است.
  if (out.type === 'object' && out.properties && Object.keys(out.properties).length === 0)
    delete out.properties;
  return out;
}

// ───────────── canonical → Gemini request ─────────────

export interface ToGeminiRequestOptions extends TranslateOptions {
  /** آستانهٔ پیش‌فرض safetySettings برای همهٔ دسته‌ها. */
  safetyThreshold?: string;
  /** جایگزینی کامل safetySettings (از options provider). */
  safetySettings?: unknown[];
}

export const GEMINI_SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
] as const;

/** پیش‌فرض گیت‌وی: مثل OpenAI و Anthropic پاسخ را خودمان مسدود نمی‌کنیم. */
export const GEMINI_DEFAULT_SAFETY_THRESHOLD = 'BLOCK_NONE';

const BUDGET_FROM_EFFORT = { minimal: 512, low: 1_024, medium: 8_192, high: 24_576 } as const;

const EXT_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  pdf: 'application/pdf',
};

function imagePart(part: CanonicalImagePart): Json {
  if (part.source.kind === 'base64')
    return { inlineData: { mimeType: part.source.mediaType, data: part.source.data } };
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(part.source.url)?.[1]?.toLowerCase() ?? '';
  return { fileData: { mimeType: EXT_MIME[ext] ?? 'image/jpeg', fileUri: part.source.url } };
}

function toolResponse(text: string, isError: boolean): Json {
  if (!isError) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
    } catch {
      // متن ساده
    }
  }
  return isError ? { error: text } : { result: text };
}

function partsFor(
  message: CanonicalMessage,
  toolNames: ReadonlyMap<string, string>,
  onDrop: DropReporter,
): Json[] {
  const parts: Json[] = [];
  let firstCall = true;
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        if (part.text !== '') parts.push({ text: part.text });
        break;
      case 'image':
        parts.push(imagePart(part));
        break;
      case 'tool_call': {
        const { signature } = decodeGeminiToolCallId(part.id);
        parts.push({
          functionCall: {
            name: part.name,
            args: parseToolArguments(part.arguments, onDrop) ?? {},
          },
          // فقط اولین functionCall هر نوبت امضا لازم دارد.
          ...(signature
            ? { thoughtSignature: signature }
            : firstCall
              ? { thoughtSignature: GEMINI_SKIP_SIGNATURE }
              : {}),
        });
        firstCall = false;
        break;
      }
      case 'tool_result': {
        const text = part.content
          .map((c) => (c.type === 'text' ? c.text : ''))
          .filter(Boolean)
          .join('\n');
        if (part.content.some((c) => c.type === 'image'))
          onDrop('tool_result.image', 'Gemini functionResponse carries JSON only');
        parts.push({
          functionResponse: {
            name: toolNames.get(part.toolCallId) ?? 'tool',
            response: toolResponse(text, part.isError === true),
          },
        });
        break;
      }
      case 'reasoning':
        onDrop('assistant.reasoning', 'Gemini thoughts are not replayed');
        break;
    }
  }
  return parts;
}

export function canonicalToGeminiRequest(
  req: CanonicalRequest,
  options: ToGeminiRequestOptions = {},
): Json {
  const onDrop = options.onDrop ?? ignoreDrops;

  const toolNames = new Map<string, string>();
  for (const message of req.messages)
    for (const part of message.content)
      if (part.type === 'tool_call') toolNames.set(part.id, part.name);

  const contents: { role: 'user' | 'model'; parts: Json[] }[] = [];
  for (const message of req.messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = partsFor(message, toolNames, onDrop);
    if (parts.length === 0) continue;
    const last = contents.at(-1);
    if (last?.role === role) {
      if (message.role === 'tool') {
        // functionResponseها باید اول پیام کاربر بیایند، به ترتیب خودشان.
        let at = 0;
        while (last.parts[at]?.functionResponse !== undefined) at++;
        last.parts.splice(at, 0, ...parts);
      } else last.parts.push(...parts);
    } else contents.push({ role, parts });
  }

  const body: Json = { contents };
  if (req.system.length > 0)
    body.systemInstruction = { parts: req.system.map((p) => ({ text: p.text })) };

  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: toGeminiSchema(t.parameters, onDrop),
        })),
      },
    ];
  }
  if (req.toolChoice !== undefined) {
    const choice = req.toolChoice;
    body.toolConfig = {
      functionCallingConfig:
        choice === 'auto'
          ? { mode: 'AUTO' }
          : choice === 'none'
            ? { mode: 'NONE' }
            : choice === 'required'
              ? { mode: 'ANY' }
              : { mode: 'ANY', allowedFunctionNames: [choice.name] },
    };
  }
  if (req.parallelToolCalls === false)
    onDrop('parallel_tool_calls', 'Gemini cannot disable parallel function calls');

  const generationConfig: Json = {};
  if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.topP !== undefined) generationConfig.topP = req.topP;
  if (req.topK !== undefined) generationConfig.topK = req.topK;
  if (req.stop?.length) generationConfig.stopSequences = req.stop.slice(0, 5);
  if (req.seed !== undefined) generationConfig.seed = req.seed;
  const format = req.responseFormat;
  if (format?.type === 'json_object') generationConfig.responseMimeType = 'application/json';
  if (format?.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = toGeminiSchema(format.schema, onDrop);
  }
  const budget =
    req.reasoning?.budgetTokens ??
    (req.reasoning?.effort ? BUDGET_FROM_EFFORT[req.reasoning.effort] : undefined);
  if (budget !== undefined)
    generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  body.safetySettings =
    options.safetySettings ??
    GEMINI_SAFETY_CATEGORIES.map((category) => ({
      category,
      threshold: options.safetyThreshold ?? GEMINI_DEFAULT_SAFETY_THRESHOLD,
    }));
  if (req.user !== undefined) onDrop('user', 'Gemini has no end-user field');
  return body;
}

// ───────────── Gemini response → canonical ─────────────

const FINISH_IN: Readonly<Record<string, CanonicalFinishReason>> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  IMAGE_SAFETY: 'content_filter',
  MALFORMED_FUNCTION_CALL: 'error',
  UNEXPECTED_TOOL_CALL: 'error',
  LANGUAGE: 'other',
  OTHER: 'other',
};

export function geminiFinishToCanonical(
  reason: string | undefined,
  hasToolCalls: boolean,
): CanonicalFinishReason {
  if (!reason) return 'other';
  const mapped = FINISH_IN[reason] ?? 'other';
  // Gemini برای فراخوانی تابع هم STOP می‌دهد.
  return mapped === 'stop' && hasToolCalls ? 'tool_calls' : mapped;
}

export function geminiUsageToCanonical(usage: GeminiUsageMetadata | undefined): CanonicalUsage {
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage?.candidatesTokenCount ?? 0) + thoughts,
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: thoughts,
  };
}

let callCounter = 0;
const newCallId = () => `call_${Date.now().toString(36)}${(callCounter++).toString(36)}`;

function geminiPartToCanonical(part: GeminiPart): CanonicalPart | undefined {
  if (part.functionCall) {
    return {
      type: 'tool_call',
      id: encodeGeminiToolCallId(part.functionCall.id ?? newCallId(), part.thoughtSignature),
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {}),
    };
  }
  if (typeof part.text === 'string')
    return part.thought
      ? { type: 'reasoning', text: part.text }
      : { type: 'text', text: part.text };
  return undefined;
}

export function geminiResponseToCanonical(
  res: GeminiGenerateContentResponse,
  options: { model: string },
): CanonicalResponse {
  const candidate = res.candidates?.[0];
  const content: CanonicalPart[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    const p = geminiPartToCanonical(part);
    if (!p) continue;
    const last = content.at(-1);
    // Gemini گاهی متن را در چند part پشت‌سرهم می‌دهد.
    if (p.type === 'text' && last?.type === 'text') last.text += p.text;
    else content.push(p);
  }
  const hasToolCalls = content.some((p) => p.type === 'tool_call');
  const blocked = !candidate && res.promptFeedback?.blockReason;
  const raw = blocked ? res.promptFeedback?.blockReason : candidate?.finishReason;
  return {
    id: res.responseId ?? `gen-${Date.now().toString(36)}`,
    model: res.modelVersion ?? options.model,
    content,
    finishReason: blocked ? 'content_filter' : geminiFinishToCanonical(raw, hasToolCalls),
    ...(raw ? { rawFinishReason: raw } : {}),
    ...(res.usageMetadata ? { usage: geminiUsageToCanonical(res.usageMetadata) } : {}),
    created: Math.floor(Date.now() / 1000),
  };
}

// ───────────── Gemini stream → canonical ─────────────

/**
 * هر رویداد SSE یک GenerateContentResponse کامل با بخشی از پاسخ است. functionCall
 * همیشه کامل در یک chunk می‌آید. usageMetadata تجمعی است و فقط آخرینش گزارش می‌شود.
 */
export class GeminiStreamDecoder {
  #started = false;
  #nextIndex = 0;
  #textIndex: number | undefined;
  #reasoningIndex: number | undefined;
  readonly #open = new Set<number>();
  #hasToolCalls = false;
  #finished = false;
  #usage: GeminiUsageMetadata | undefined;

  constructor(private readonly model: string) {}

  push(chunk: GeminiGenerateContentResponse): CanonicalStreamEvent[] {
    const out: CanonicalStreamEvent[] = [];
    if (!this.#started) {
      this.#started = true;
      out.push({
        type: 'start',
        id: chunk.responseId ?? `gen-${Date.now().toString(36)}`,
        model: chunk.modelVersion ?? this.model,
        created: Math.floor(Date.now() / 1000),
      });
    }
    if (chunk.usageMetadata) this.#usage = chunk.usageMetadata;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      const p = geminiPartToCanonical(part);
      if (!p) continue;
      if (p.type === 'tool_call') {
        this.#hasToolCalls = true;
        const index = this.#allocate();
        out.push({ type: 'tool_call_start', index, id: p.id, name: p.name });
        out.push({ type: 'tool_call_delta', index, argumentsDelta: p.arguments });
      } else if (p.type === 'reasoning') {
        if (p.text === '') continue;
        this.#reasoningIndex ??= this.#allocate();
        out.push({ type: 'reasoning_delta', index: this.#reasoningIndex, text: p.text });
      } else if (p.type === 'text' && p.text !== '') {
        this.#textIndex ??= this.#allocate();
        out.push({ type: 'text_delta', index: this.#textIndex, text: p.text });
      }
    }
    const blocked = !candidate && chunk.promptFeedback?.blockReason;
    const raw = blocked ? chunk.promptFeedback?.blockReason : candidate?.finishReason;
    if (raw && !this.#finished) {
      this.#finished = true;
      for (const index of this.#open) out.push({ type: 'content_end', index });
      this.#open.clear();
      if (this.#usage) out.push({ type: 'usage', usage: geminiUsageToCanonical(this.#usage) });
      out.push({
        type: 'finish',
        finishReason: blocked ? 'content_filter' : geminiFinishToCanonical(raw, this.#hasToolCalls),
        rawFinishReason: raw,
      });
    }
    return out;
  }

  #allocate(): number {
    const index = this.#nextIndex++;
    this.#open.add(index);
    return index;
  }
}
