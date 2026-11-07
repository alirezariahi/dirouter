/**
 * Anthropic Messages ⇄ canonical.
 *
 * نکتهٔ usage: در Anthropic مقدار `input_tokens` توکن‌های cache را شامل نمی‌شود،
 * ولی در canonical `inputTokens` کل ورودی است و cacheRead/cacheWrite زیرمجموعهٔ آن.
 */
import type {
  AnthropicInputContentBlock,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicOutputContentBlock,
  AnthropicStopReason,
  AnthropicUsage,
  CanonicalFinishReason,
  CanonicalImagePart,
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTextPart,
  CanonicalToolChoice,
  CanonicalUsage,
} from '@dirouter/contracts';

import {
  type DropReporter,
  emptyUsage,
  type FinishReasonMap,
  ignoreDrops,
  parseToolArguments,
  type TranslateOptions,
} from './common.js';

const CONSUMED_REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'max_tokens',
  'system',
  'stream',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'tools',
  'tool_choice',
  'thinking',
  'metadata',
]);

/** کلید passthrough برای server toolهای Anthropic (web_search، …). */
export const SERVER_TOOLS_KEY = '__anthropic_server_tools';

function imageIn(
  block: Extract<AnthropicInputContentBlock, { type: 'image' }>,
  onDrop: DropReporter,
): CanonicalImagePart | undefined {
  const { source } = block;
  if (source.type === 'base64')
    return {
      type: 'image',
      source: { kind: 'base64', mediaType: source.media_type, data: source.data },
    };
  if (source.type === 'url') return { type: 'image', source: { kind: 'url', url: source.url } };
  onDrop('image.source.file', 'Files API references are not portable');
  return undefined;
}

function toolResultContent(
  content: Extract<AnthropicInputContentBlock, { type: 'tool_result' }>['content'],
  onDrop: DropReporter,
): (CanonicalTextPart | CanonicalImagePart)[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.flatMap((b): (CanonicalTextPart | CanonicalImagePart)[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }];
    const image = imageIn(b, onDrop);
    return image ? [image] : [];
  });
}

export function anthropicRequestToCanonical(
  req: AnthropicMessagesRequest,
  options: TranslateOptions = {},
): CanonicalRequest {
  const onDrop = options.onDrop ?? ignoreDrops;
  const system: CanonicalTextPart[] =
    req.system === undefined
      ? []
      : typeof req.system === 'string'
        ? [{ type: 'text', text: req.system }]
        : req.system.map((b) => ({
            type: 'text',
            text: b.text,
            ...(b.cache_control ? { cache: true } : {}),
          }));

  const messages: CanonicalMessage[] = [];
  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: [{ type: 'text', text: message.content }] });
      continue;
    }
    const content: CanonicalPart[] = [];
    const toolResults: CanonicalPart[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          content.push({
            type: 'text',
            text: block.text,
            ...(block.cache_control ? { cache: true } : {}),
          });
          break;
        case 'image': {
          const image = imageIn(block, onDrop);
          if (image) content.push(image);
          break;
        }
        case 'tool_use':
          content.push({
            type: 'tool_call',
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;
        case 'tool_result':
          toolResults.push({
            type: 'tool_result',
            toolCallId: block.tool_use_id,
            content: toolResultContent(block.content, onDrop),
            ...(block.is_error ? { isError: true } : {}),
          });
          break;
        case 'thinking':
          content.push({ type: 'reasoning', text: block.thinking, signature: block.signature });
          break;
        case 'redacted_thinking':
          content.push({ type: 'reasoning', text: '', redacted: block.data });
          break;
        case 'document':
          onDrop('messages[].content[].document', 'document blocks are not portable');
          break;
      }
    }
    // tool_resultها در canonical پیام جدای «tool» هستند و قبل از بقیهٔ محتوای کاربر می‌آیند.
    if (toolResults.length > 0) messages.push({ role: 'tool', content: toolResults });
    if (content.length > 0) messages.push({ role: message.role, content });
  }

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req)) {
    if (!CONSUMED_REQUEST_FIELDS.has(key) && value !== undefined) passthrough[key] = value;
  }

  const tools: CanonicalRequest['tools'] = [];
  const serverTools: unknown[] = [];
  for (const tool of req.tools ?? []) {
    if ('input_schema' in tool && (tool.type === undefined || tool.type === 'custom')) {
      tools.push({
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.input_schema as Record<string, unknown>,
      });
    } else {
      serverTools.push(tool);
    }
  }
  if (serverTools.length > 0) passthrough[SERVER_TOOLS_KEY] = serverTools;

  let toolChoice: CanonicalToolChoice | undefined;
  let parallelToolCalls: boolean | undefined;
  if (req.tool_choice) {
    const choice = req.tool_choice;
    toolChoice =
      choice.type === 'auto'
        ? 'auto'
        : choice.type === 'any'
          ? 'required'
          : choice.type === 'none'
            ? 'none'
            : { name: choice.name };
    if ('disable_parallel_tool_use' in choice && choice.disable_parallel_tool_use === true)
      parallelToolCalls = false;
  }

  const thinking = req.thinking;
  return {
    inboundApi: 'anthropic.messages',
    model: req.model,
    system,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    maxOutputTokens: req.max_tokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { topP: req.top_p } : {}),
    ...(req.top_k !== undefined ? { topK: req.top_k } : {}),
    ...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
    ...(thinking?.type === 'enabled'
      ? { reasoning: { budgetTokens: thinking.budget_tokens } }
      : {}),
    ...(thinking?.type === 'adaptive' ? { reasoning: { effort: 'medium' as const } } : {}),
    stream: req.stream === true,
    ...(req.metadata?.user_id ? { user: req.metadata.user_id } : {}),
    ...(Object.keys(passthrough).length > 0 ? { passthrough } : {}),
  };
}

// ───────────── canonical → Anthropic request (provider) ─────────────

export interface ToAnthropicRequestOptions extends TranslateOptions {
  upstreamModel: string;
  /** max_tokens در Anthropic اجباری است؛ اگر کلاینت نداد این مقدار استفاده می‌شود. */
  defaultMaxTokens?: number;
}

const BUDGET_FROM_EFFORT = { minimal: 1_024, low: 2_048, medium: 8_192, high: 16_384 } as const;

type Block = Record<string, unknown>;

function imageBlock(part: CanonicalImagePart): Block {
  return {
    type: 'image',
    source:
      part.source.kind === 'url'
        ? { type: 'url', url: part.source.url }
        : { type: 'base64', media_type: part.source.mediaType, data: part.source.data },
  };
}

function blocksFor(message: CanonicalMessage, onDrop: DropReporter): Block[] {
  const reasoning: Block[] = [];
  const rest: Block[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        rest.push({
          type: 'text',
          text: part.text,
          ...(part.cache ? { cache_control: { type: 'ephemeral' } } : {}),
        });
        break;
      case 'image':
        rest.push(imageBlock(part));
        break;
      case 'tool_call':
        rest.push({
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: parseToolArguments(part.arguments, onDrop),
        });
        break;
      case 'tool_result':
        rest.push({
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: part.content.map((c) =>
            c.type === 'text' ? { type: 'text', text: c.text } : imageBlock(c),
          ),
          ...(part.isError ? { is_error: true } : {}),
        });
        break;
      case 'reasoning':
        // Anthropic فقط thinking امضاشدهٔ خودش را می‌پذیرد و باید اول پیام بیاید.
        if (part.redacted !== undefined)
          reasoning.push({ type: 'redacted_thinking', data: part.redacted });
        else if (part.signature)
          reasoning.push({ type: 'thinking', thinking: part.text, signature: part.signature });
        else onDrop('assistant.reasoning', 'unsigned reasoning cannot be sent to Anthropic');
        break;
    }
  }
  return [...reasoning, ...rest];
}

export function canonicalToAnthropicRequest(
  req: CanonicalRequest,
  options: ToAnthropicRequestOptions,
): Record<string, unknown> {
  const onDrop = options.onDrop ?? ignoreDrops;

  // نقش tool به user تبدیل و پیام‌های هم‌نقش پشت‌سرهم ادغام می‌شوند (Anthropic نقش‌ها را یکی‌درمیان می‌خواهد).
  const messages: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  for (const message of req.messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = blocksFor(message, onDrop);
    if (blocks.length === 0) continue;
    const last = messages.at(-1);
    if (last?.role === role) {
      if (message.role === 'tool') {
        // tool_resultها باید اول پیام کاربر بیایند، با حفظ ترتیب خودشان.
        let at = 0;
        while (last.content[at]?.type === 'tool_result') at++;
        last.content.splice(at, 0, ...blocks);
      } else {
        last.content.push(...blocks);
      }
    } else {
      messages.push({ role, content: blocks });
    }
  }

  const body: Record<string, unknown> = {};
  const { [SERVER_TOOLS_KEY]: serverTools, ...passthrough } =
    req.inboundApi === 'anthropic.messages' ? (req.passthrough ?? {}) : {};
  Object.assign(body, passthrough);

  let maxTokens = req.maxOutputTokens ?? options.defaultMaxTokens ?? 4_096;
  Object.assign(body, { model: options.upstreamModel, messages });

  if (req.system.length > 0) {
    const hasCache = req.system.some((p) => p.cache);
    body.system = hasCache
      ? req.system.map((p) => ({
          type: 'text',
          text: p.text,
          ...(p.cache ? { cache_control: { type: 'ephemeral' } } : {}),
        }))
      : req.system.map((p) => p.text).join('\n\n');
  }

  const tools: unknown[] = (req.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.parameters,
  }));
  if (Array.isArray(serverTools)) tools.push(...(serverTools as unknown[]));
  if (tools.length > 0) body.tools = tools;

  if (req.toolChoice !== undefined || req.parallelToolCalls === false) {
    const choice = req.toolChoice ?? 'auto';
    const base: Block =
      choice === 'auto'
        ? { type: 'auto' }
        : choice === 'none'
          ? { type: 'none' }
          : choice === 'required'
            ? { type: 'any' }
            : { type: 'tool', name: choice.name };
    if (req.parallelToolCalls === false && base.type !== 'none')
      base.disable_parallel_tool_use = true;
    if (tools.length > 0 || choice === 'none') body.tool_choice = base;
  }

  const budget =
    req.reasoning?.budgetTokens ??
    (req.reasoning?.effort ? BUDGET_FROM_EFFORT[req.reasoning.effort] : undefined);
  if (budget !== undefined) {
    const budgetTokens = Math.max(1_024, budget);
    // Anthropic: budget_tokens باید کمتر از max_tokens باشد.
    if (maxTokens <= budgetTokens) maxTokens = budgetTokens + 1_024;
    body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
  }
  body.max_tokens = maxTokens;

  if (req.temperature !== undefined) {
    if (req.temperature > 1) onDrop('temperature', 'clamped to 1 (Anthropic range is 0–1)');
    body.temperature = Math.min(1, req.temperature);
  }
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.topK !== undefined) body.top_k = req.topK;
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (req.seed !== undefined) onDrop('seed', 'Anthropic has no seed');
  if (req.responseFormat && req.responseFormat.type !== 'text')
    onDrop('response_format', 'Anthropic has no native JSON mode');
  if (req.user !== undefined) body.metadata = { user_id: req.user };
  if (req.stream) body.stream = true;
  return body;
}

// ───────────── Anthropic response → canonical ─────────────

const STOP_IN: Readonly<Record<string, CanonicalFinishReason | undefined>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'refusal',
  pause_turn: 'other',
  model_context_window_exceeded: 'length',
} satisfies Record<AnthropicStopReason, CanonicalFinishReason>;

export function anthropicStopToCanonical(reason: string | null | undefined): CanonicalFinishReason {
  if (!reason) return 'other';
  return STOP_IN[reason] ?? 'other';
}

export function anthropicUsageToCanonical(
  usage: Partial<AnthropicUsage> | null | undefined,
): CanonicalUsage {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (usage?.input_tokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: 0,
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function anthropicBlockToCanonical(
  block: AnthropicOutputContentBlock,
): CanonicalPart | undefined {
  const b = block as Record<string, unknown> & { type: string };
  switch (b.type) {
    case 'text':
      return { type: 'text', text: str(b.text) };
    case 'tool_use':
      return {
        type: 'tool_call',
        id: str(b.id),
        name: str(b.name),
        arguments: JSON.stringify(b.input ?? {}),
      };
    case 'thinking':
      return {
        type: 'reasoning',
        text: str(b.thinking),
        ...(str(b.signature) ? { signature: str(b.signature) } : {}),
      };
    case 'redacted_thinking':
      return { type: 'reasoning', text: '', redacted: str(b.data) };
    default:
      return undefined;
  }
}

export function anthropicResponseToCanonical(res: AnthropicMessagesResponse): CanonicalResponse {
  return {
    id: res.id,
    model: res.model,
    content: res.content
      .map(anthropicBlockToCanonical)
      .filter((p): p is CanonicalPart => p !== undefined),
    finishReason: anthropicStopToCanonical(res.stop_reason),
    ...(res.stop_reason ? { rawFinishReason: res.stop_reason } : {}),
    usage: anthropicUsageToCanonical(res.usage),
    created: Math.floor(Date.now() / 1000),
  };
}

// ───────────── canonical → Anthropic response (client) ─────────────

export const FINISH_TO_ANTHROPIC: FinishReasonMap<AnthropicStopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
  refusal: 'refusal',
  error: 'end_turn',
  other: 'end_turn',
};

export function canonicalUsageToAnthropic(usage: CanonicalUsage): AnthropicUsage {
  return {
    input_tokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens),
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
  };
}

export function canonicalToAnthropicResponse(
  res: CanonicalResponse,
  options: { model: string } & TranslateOptions,
): AnthropicMessagesResponse {
  const onDrop = options.onDrop ?? ignoreDrops;
  const content: AnthropicOutputContentBlock[] = [];
  for (const part of res.content) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text });
    else if (part.type === 'tool_call')
      content.push({
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: parseToolArguments(part.arguments, onDrop),
      });
    else if (part.type === 'reasoning') {
      if (part.redacted !== undefined)
        content.push({ type: 'redacted_thinking', data: part.redacted });
      else content.push({ type: 'thinking', thinking: part.text, signature: part.signature ?? '' });
    }
  }
  return {
    id: res.id.startsWith('msg_') ? res.id : `msg_${res.id}`,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content,
    stop_reason: FINISH_TO_ANTHROPIC[res.finishReason],
    stop_sequence: null,
    usage: canonicalUsageToAnthropic(res.usage ?? emptyUsage()),
  };
}
