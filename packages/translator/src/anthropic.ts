/**
 * Anthropic Messages ⇄ canonical.
 *
 * Usage note: in Anthropic, `input_tokens` does not include cache tokens,
 * but in canonical `inputTokens` is the total input and cacheRead/cacheWrite are subsets of it.
 */
import type {
  AnthropicInputContentBlock,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicOutputContentBlock,
  AnthropicStopReason,
  AnthropicUsage,
  CanonicalDocumentPart,
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
  cacheControlOut,
  cacheMarkerIn,
  describeMedia,
  type DropReporter,
  emptyUsage,
  type FinishReasonMap,
  ignoreDrops,
  parseToolArguments,
  type TranslateOptions,
  UnsupportedContentError,
} from './common.js';
import { anthropicCitationIn, anthropicCitationOut } from './citations.js';
import { applyUpstreamFields, reportForeignPassthrough } from './params.js';
import {
  anthropicServerToolsIn,
  anthropicServerToolsOut,
  SERVER_TOOLS_KEY,
} from './server-tools.js';
import {
  claudeStructuredOutputMode,
  JSON_ONLY_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL,
  type StructuredOutputMode,
  structuredOutputTool,
  unwrapStructuredOutput,
} from './structured.js';

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

/** Passthrough key for Anthropic server tools (web_search, …). */
export { SERVER_TOOLS_KEY } from './server-tools.js';

function imageIn(
  block: Extract<AnthropicInputContentBlock, { type: 'image' }>,
  onDrop: DropReporter,
): CanonicalImagePart | undefined {
  const { source } = block;
  const cache = cacheMarkerIn(block.cache_control);
  if (source.type === 'base64')
    return {
      type: 'image',
      source: { kind: 'base64', mediaType: source.media_type, data: source.data },
      ...cache,
    };
  if (source.type === 'url')
    return { type: 'image', source: { kind: 'url', url: source.url }, ...cache };
  onDrop('image.source.file', 'Files API references are not portable');
  return undefined;
}

/**
 * Anthropic `document` block → canonical (card 27.2). Sources: `base64` (PDF), `url`, `text`,
 * `content` (blocks, kept as their text) and `file` (Files API id).
 */
function documentIn(
  block: Extract<AnthropicInputContentBlock, { type: 'document' }>,
  onDrop: DropReporter,
): CanonicalDocumentPart | undefined {
  const source = block.source as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  let canonical: CanonicalDocumentPart['source'] | undefined;
  switch (source.type) {
    case 'base64':
      canonical = {
        kind: 'base64',
        mediaType: str(source.media_type) ?? 'application/pdf',
        data: str(source.data) ?? '',
      };
      break;
    case 'url':
      canonical = { kind: 'url', url: str(source.url) ?? '' };
      break;
    case 'text':
      canonical = {
        kind: 'text',
        text: str(source.data) ?? '',
        mediaType: str(source.media_type) ?? 'text/plain',
      };
      break;
    case 'content': {
      const blocks = Array.isArray(source.content) ? (source.content as unknown[]) : [];
      const texts = blocks.flatMap((b) => {
        const item = b as { type?: unknown; text?: unknown };
        if (item.type === 'text' && typeof item.text === 'string') return [item.text];
        onDrop('document.source.content[]', 'only text blocks of a content document are kept');
        return [];
      });
      if (typeof source.content === 'string') texts.push(source.content);
      canonical = { kind: 'text', text: texts.join('\n\n') };
      break;
    }
    case 'file':
      canonical = { kind: 'file', fileId: str(source.file_id) ?? '', origin: 'anthropic' };
      break;
    default:
      onDrop('document.source', `unknown document source '${String(source.type)}'`);
      return undefined;
  }
  const citations = (block as { citations?: { enabled?: unknown } | null }).citations;
  return {
    type: 'document',
    source: canonical,
    ...(block.title ? { title: block.title } : {}),
    ...(block.context ? { context: block.context } : {}),
    ...(citations?.enabled === true ? { citations: true } : {}),
    ...cacheMarkerIn(block.cache_control),
  };
}

function toolResultContent(
  content: Extract<AnthropicInputContentBlock, { type: 'tool_result' }>['content'],
  onDrop: DropReporter,
): (CanonicalTextPart | CanonicalImagePart)[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.flatMap((b): (CanonicalTextPart | CanonicalImagePart)[] => {
    if (b.type === 'text')
      return [{ type: 'text', text: b.text, ...cacheMarkerIn(b.cache_control) }];
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
            ...cacheMarkerIn(b.cache_control),
          }));

  const messages: CanonicalMessage[] = [];
  for (const message of req.messages) {
    // A system message in the conversation (current Claude Code sends its environment notes this
    // way) joins the system prompt, after the cached blocks, so every upstream accepts it and the
    // cached prefix stays the same.
    if (message.role === 'system') {
      const texts =
        typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
      for (const text of texts) if (text) system.push({ type: 'text', text });
      continue;
    }
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
            ...cacheMarkerIn(block.cache_control),
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
            ...cacheMarkerIn(block.cache_control),
          });
          break;
        case 'tool_result':
          toolResults.push({
            type: 'tool_result',
            toolCallId: block.tool_use_id,
            content: toolResultContent(block.content, onDrop),
            ...(block.is_error ? { isError: true } : {}),
            ...cacheMarkerIn(block.cache_control),
          });
          break;
        case 'thinking':
          content.push({ type: 'reasoning', text: block.thinking, signature: block.signature });
          break;
        case 'redacted_thinking':
          content.push({ type: 'reasoning', text: '', redacted: block.data });
          break;
        case 'document': {
          const document = documentIn(block, onDrop);
          if (document) content.push(document);
          break;
        }
      }
    }
    // In canonical, tool_results are separate "tool" messages and come before the rest of the user content.
    if (toolResults.length > 0) messages.push({ role: 'tool', content: toolResults });
    if (content.length > 0) messages.push({ role: message.role, content });
  }

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req)) {
    if (!CONSUMED_REQUEST_FIELDS.has(key) && value !== undefined) passthrough[key] = value;
  }
  const responseFormat = anthropicFormatIn(passthrough);

  const tools: CanonicalRequest['tools'] = [];
  const serverTools: unknown[] = [];
  for (const tool of req.tools ?? []) {
    if ('input_schema' in tool && (tool.type === undefined || tool.type === 'custom')) {
      tools.push({
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.input_schema as Record<string, unknown>,
        ...cacheMarkerIn(tool.cache_control),
      });
    } else {
      serverTools.push(tool);
    }
  }
  if (serverTools.length > 0) passthrough[SERVER_TOOLS_KEY] = serverTools;
  const portableServerTools = anthropicServerToolsIn(serverTools);

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
    ...(responseFormat ? { responseFormat } : {}),
    ...(portableServerTools.length ? { serverTools: portableServerTools } : {}),
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

/**
 * Structured output requested by an Anthropic client (`output_config.format`, or the older
 * `output_format`) becomes the canonical `responseFormat`, so it also reaches OpenAI and Gemini.
 * The field is taken out of the passthrough; the translator to Anthropic writes it back.
 */
function anthropicFormatIn(
  passthrough: Record<string, unknown>,
): CanonicalRequest['responseFormat'] | undefined {
  const asObject = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const config = asObject(passthrough.output_config);
  const format = asObject(config?.format) ?? asObject(passthrough.output_format);
  const schema = asObject(format?.schema);
  if (format?.type !== 'json_schema' || !schema) return undefined;
  if (config?.format !== undefined) {
    const { format: _format, ...rest } = config;
    if (Object.keys(rest).length > 0) passthrough.output_config = rest;
    else delete passthrough.output_config;
  } else {
    delete passthrough.output_format;
  }
  return { type: 'json_schema', name: 'output', schema };
}

// ───────────── canonical → Anthropic request (provider) ─────────────

export interface ToAnthropicRequestOptions extends TranslateOptions {
  upstreamModel: string;
  /** max_tokens is required in Anthropic; this value is used if the client does not send one. */
  defaultMaxTokens?: number;
  /**
   * How `response_format` is sent (card 27.1): `native` uses `output_config.format`, `tool` a forced
   * tool. Defaults to what the upstream model is known to support.
   */
  structuredOutput?: StructuredOutputMode;
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
    ...cacheControlOut(part),
  };
}

/**
 * Canonical document → Anthropic `document` block (card 27.2). PDFs travel as `base64` or `url`,
 * text as a `text` source (base64 `text/plain` is decoded); Anthropic has no audio input.
 */
function documentBlock(part: CanonicalDocumentPart): Block {
  const refuse = (why: string) =>
    new UnsupportedContentError(
      'messages[].content[].document',
      `Anthropic cannot take ${describeMedia(part)}: ${why}`,
    );
  const { source } = part;
  let wire: Block;
  switch (source.kind) {
    case 'base64':
      if (source.mediaType === 'application/pdf')
        wire = { type: 'base64', media_type: source.mediaType, data: source.data };
      else if (source.mediaType.startsWith('text/'))
        wire = {
          type: 'text',
          media_type: 'text/plain',
          data: Buffer.from(source.data, 'base64').toString('utf8'),
        };
      else throw refuse('only PDF and plain-text documents are accepted');
      break;
    case 'url':
      wire = { type: 'url', url: source.url };
      break;
    case 'text':
      wire = { type: 'text', media_type: 'text/plain', data: source.text };
      break;
    case 'file':
      if (source.origin !== 'anthropic')
        throw refuse(`a ${source.origin} file id is not valid here`);
      wire = { type: 'file', file_id: source.fileId };
      break;
  }
  return {
    type: 'document',
    source: wire,
    ...(part.title !== undefined ? { title: part.title } : {}),
    ...(part.context !== undefined ? { context: part.context } : {}),
    ...(part.citations ? { citations: { enabled: true } } : {}),
    ...cacheControlOut(part),
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
          ...cacheControlOut(part),
        });
        break;
      case 'image':
        rest.push(imageBlock(part));
        break;
      case 'document':
        rest.push(documentBlock(part));
        break;
      case 'audio':
        throw new UnsupportedContentError(
          'messages[].content[].audio',
          `Anthropic cannot take ${describeMedia(part)}: Claude has no audio input`,
        );
      case 'tool_call':
        rest.push({
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: parseToolArguments(part.arguments, onDrop),
          ...cacheControlOut(part),
        });
        break;
      case 'tool_result':
        rest.push({
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: part.content.map((c) =>
            c.type === 'text'
              ? { type: 'text', text: c.text, ...cacheControlOut(c) }
              : imageBlock(c),
          ),
          ...(part.isError ? { is_error: true } : {}),
          ...cacheControlOut(part),
        });
        break;
      case 'reasoning':
        // Anthropic only accepts its own signed thinking, and it must come first in the message.
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

  // The tool role is converted to user, and consecutive same-role messages are merged (Anthropic requires alternating roles).
  const messages: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  for (const message of req.messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = blocksFor(message, onDrop);
    if (blocks.length === 0) continue;
    const last = messages.at(-1);
    if (last?.role === role) {
      if (message.role === 'tool') {
        // tool_results must come first in the user message, preserving their own order.
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
          ...cacheControlOut(p),
        }))
      : req.system.map((p) => p.text).join('\n\n');
  }

  const tools: unknown[] = (req.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.parameters,
    ...cacheControlOut(t),
  }));
  // The client's own Anthropic server tools as sent; from another API, the portable ones.
  if (Array.isArray(serverTools)) tools.push(...(serverTools as unknown[]));
  else tools.push(...anthropicServerToolsOut(req.serverTools));

  const structured = structuredOutputFor(req, options, onDrop);
  if (structured.tool) tools.push(structured.tool);
  if (tools.length > 0) body.tools = tools;

  if (structured.toolChoice) {
    body.tool_choice = structured.toolChoice;
  } else if (req.toolChoice !== undefined || req.parallelToolCalls === false) {
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
    // Anthropic: budget_tokens must be less than max_tokens.
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
  if (req.seed !== undefined) onDrop('seed', 'Anthropic has no seed', 'parameter');
  if (req.logprobs) onDrop('logprobs', 'Anthropic returns no log probabilities', 'parameter');
  if (structured.format) {
    const current = body.output_config;
    body.output_config = {
      ...(current && typeof current === 'object' ? current : {}),
      format: structured.format,
    };
  }
  if (structured.instruction) {
    const text = structured.instruction;
    if (typeof body.system === 'string') body.system = `${body.system}\n\n${text}`;
    else if (Array.isArray(body.system))
      body.system = [...(body.system as unknown[]), { type: 'text', text }];
    else body.system = text;
  }
  if (req.user !== undefined) body.metadata = { user_id: req.user };
  if (req.stream) body.stream = true;
  reportForeignPassthrough(req, req.inboundApi === 'anthropic.messages', 'Anthropic', onDrop);
  return applyUpstreamFields(body, req);
}

interface StructuredOutputPlan {
  /** `output_config.format` (native structured outputs). */
  format?: Block;
  /** Fallback tool definition and the `tool_choice` that forces it. */
  tool?: Block;
  toolChoice?: Block;
  /** Extra system text when neither guarantees JSON. */
  instruction?: string;
}

/**
 * Card 27.1: `response_format` for Claude. Native models get `output_config.format`; the rest get a
 * forced tool whose call the response translators turn back into text. `json_object` has no schema
 * to enforce natively, so on native-only models it becomes an instruction (reported as a drop).
 */
function structuredOutputFor(
  req: CanonicalRequest,
  options: ToAnthropicRequestOptions,
  onDrop: DropReporter,
): StructuredOutputPlan {
  const format = req.responseFormat;
  if (!format || format.type === 'text') return {};
  const mode = options.structuredOutput ?? claudeStructuredOutputMode(options.upstreamModel);
  if (mode === 'native') {
    if (format.type === 'json_schema')
      return { format: { type: 'json_schema', schema: format.schema } };
    onDrop('response_format', 'json_object has no schema; sent as an instruction');
    return { instruction: JSON_ONLY_INSTRUCTION };
  }
  const fallback = structuredOutputTool(format);
  if (!fallback) return {};
  const tool: Block = {
    name: fallback.name,
    description: fallback.description,
    input_schema: fallback.parameters,
  };
  const thinking = req.reasoning?.budgetTokens !== undefined || req.reasoning?.effort !== undefined;
  const clientTools = (req.tools?.length ?? 0) > 0;
  // Anthropic rejects a forced tool_choice together with extended thinking: ask instead.
  if (thinking)
    return {
      tool,
      toolChoice: { type: 'auto' },
      instruction: `Give your final answer by calling the ${STRUCTURED_OUTPUT_TOOL} tool.`,
    };
  if (clientTools) {
    if (typeof req.toolChoice === 'object')
      return { tool, toolChoice: { type: 'tool', name: req.toolChoice.name } };
    if (req.toolChoice === 'none')
      return { tool, toolChoice: { type: 'tool', name: STRUCTURED_OUTPUT_TOOL } };
    return { tool, toolChoice: { type: 'any' } };
  }
  return {
    tool,
    toolChoice: { type: 'tool', name: STRUCTURED_OUTPUT_TOOL, disable_parallel_tool_use: true },
  };
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
    case 'text': {
      // Sources the text cites (card 31.7).
      const citations = (Array.isArray(b.citations) ? b.citations : [])
        .map(anthropicCitationIn)
        .filter((c) => c !== undefined);
      return { type: 'text', text: str(b.text), ...(citations.length ? { citations } : {}) };
    }
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
  return unwrapStructuredOutput({
    id: res.id,
    model: res.model,
    content: res.content
      .map(anthropicBlockToCanonical)
      .filter((p): p is CanonicalPart => p !== undefined),
    finishReason: anthropicStopToCanonical(res.stop_reason),
    ...(res.stop_reason ? { rawFinishReason: res.stop_reason } : {}),
    usage: anthropicUsageToCanonical(res.usage),
    created: Math.floor(Date.now() / 1000),
  });
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
    if (part.type === 'text')
      content.push({
        type: 'text',
        text: part.text,
        ...(part.citations?.length ? { citations: part.citations.map(anthropicCitationOut) } : {}),
      });
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
