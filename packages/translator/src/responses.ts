/**
 * OpenAI Responses API ⇄ canonical (card 11.2).
 *
 * Inbound only: Responses requests are translated to canonical and answers are encoded in
 * Responses format. Reaching a provider happens through the existing adapters.
 */
import type {
  CanonicalImagePart,
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalTextPart,
  CanonicalTool,
  CanonicalToolChoice,
  CanonicalUsage,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesReasoningEffort,
  ResponsesRequest,
} from '@dirouter/contracts';

import {
  documentFromFileData,
  type DropReporter,
  emptyUsage,
  ignoreDrops,
  imageFromUrl,
  mediaTypeFromName,
  serviceTierIn,
  type TranslateOptions,
} from './common.js';
import {
  applyPatchOutputIn,
  codingCallIn,
  codingKindOf,
  codingOutputItem,
  codingToolIn,
  customInputOf,
} from './coding-tools.js';
import { openAILogprobsOut, responsesAnnotationsOut } from './citations.js';
import { responsesServerToolIn } from './server-tools.js';
import { encodeSse } from './sse.js';

const FINISH_FROM_RESPONSES: Record<string, 'stop' | 'length' | 'tool_calls'> = {
  stop: 'stop',
  completed: 'stop',
  max_output_tokens: 'length',
  length: 'length',
  tool_calls: 'tool_calls',
};

/** Part types that carry plain text: user input, replayed assistant output, reasoning text. */
const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text', 'summary_text']);

type CanonicalEffort = NonNullable<NonNullable<CanonicalRequest['reasoning']>['effort']>;

/**
 * The canonical model knows four effort levels. Levels above `high` are clamped to `high`;
 * `none` has no canonical equivalent and is left to the provider default.
 */
const EFFORT_TO_CANONICAL: Record<ResponsesReasoningEffort, CanonicalEffort | undefined> = {
  none: undefined,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

function contentPart(
  part: ResponsesContentPart,
  field: string,
  onDrop: DropReporter,
): (CanonicalTextPart | CanonicalImagePart)[] {
  if (TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string')
    return [{ type: 'text', text: part.text }];
  if (part.type === 'refusal' && typeof part.refusal === 'string')
    return [{ type: 'text', text: part.refusal }];
  if (part.type === 'input_image' && part.image_url) {
    const detail = part.detail;
    return [
      {
        type: 'image',
        source: imageFromUrl(part.image_url),
        ...(detail === 'auto' || detail === 'low' || detail === 'high' ? { detail } : {}),
      },
    ];
  }
  onDrop(field, `unsupported part '${part.type}'`);
  return [];
}

/**
 * `input_file` (card 27.2): `file_data` (data URL or bare base64), `file_url` or an OpenAI
 * `file_id`, each with an optional `filename`.
 */
function filePart(part: ResponsesContentPart, onDrop: DropReporter): CanonicalPart[] {
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const filename = str(part.filename);
  const named = filename ? { filename } : {};
  const fileData = str(part.file_data);
  if (fileData)
    return [{ type: 'document', source: documentFromFileData(fileData, filename), ...named }];
  const fileUrl = str(part.file_url);
  if (fileUrl) {
    const mediaType = mediaTypeFromName(filename ?? fileUrl);
    return [
      {
        type: 'document',
        source: { kind: 'url', url: fileUrl, ...(mediaType ? { mediaType } : {}) },
        ...named,
      },
    ];
  }
  const fileId = str(part.file_id);
  if (fileId)
    return [{ type: 'document', source: { kind: 'file', fileId, origin: 'openai' }, ...named }];
  onDrop('input[].content[]', 'input_file without file_data, file_url or file_id');
  return [];
}

function itemParts(item: ResponsesInputItem, onDrop: DropReporter): CanonicalPart[] {
  if (typeof item.content === 'string') return [{ type: 'text', text: item.content }];
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap((part) =>
    part.type === 'input_file'
      ? filePart(part, onDrop)
      : contentPart(part, 'input[].content[]', onDrop),
  );
}

/** `function_call_output.output` is a string or an array of input parts. */
function outputParts(
  output: unknown,
  onDrop: DropReporter,
): (CanonicalTextPart | CanonicalImagePart)[] {
  if (typeof output === 'string') return [{ type: 'text', text: output }];
  if (output === undefined || output === null) return [{ type: 'text', text: '' }];
  if (Array.isArray(output)) {
    return output.flatMap((raw: unknown) => {
      if (typeof raw === 'string') return [{ type: 'text' as const, text: raw }];
      if (raw === null || typeof raw !== 'object') return [];
      const part = raw as Record<string, unknown>;
      return contentPart(
        {
          ...part,
          type: typeof part.type === 'string' ? part.type : 'unknown',
          text: typeof part.text === 'string' ? part.text : undefined,
          refusal: undefined,
          image_url: typeof part.image_url === 'string' ? part.image_url : undefined,
          detail: typeof part.detail === 'string' ? part.detail : undefined,
        },
        'input[].output[]',
        onDrop,
      );
    });
  }
  return [{ type: 'text', text: JSON.stringify(output) }];
}

/**
 * Appends parts to the trailing message when it has the same role. Responses clients replay one
 * item per output (reasoning, message, each function call), while chat-style providers need a
 * single assistant turn that carries all of its tool calls, followed by the tool results.
 */
function append(messages: CanonicalMessage[], role: 'assistant' | 'tool', parts: CanonicalPart[]) {
  const last = messages.at(-1);
  if (last?.role === role) last.content.push(...parts);
  else messages.push({ role, content: parts });
}

export function responsesRequestToCanonical(
  req: ResponsesRequest,
  options: TranslateOptions = {},
): CanonicalRequest {
  const onDrop = options.onDrop ?? ignoreDrops;
  const system = req.instructions ? [{ type: 'text' as const, text: req.instructions }] : [];
  const messages: CanonicalMessage[] = [];
  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: req.input }] });
  } else {
    for (const item of req.input) {
      // Function call / output items (replayed tool turns).
      if (item.type === 'function_call' && item.name) {
        append(messages, 'assistant', [
          {
            type: 'tool_call',
            id: item.call_id ?? item.id ?? item.name,
            name: item.name,
            arguments:
              typeof item.arguments === 'string' && item.arguments !== ''
                ? item.arguments
                : item.arguments && typeof item.arguments === 'object'
                  ? JSON.stringify(item.arguments)
                  : '{}',
          },
        ]);
        continue;
      }
      if (item.type === 'function_call_output' && item.call_id) {
        append(messages, 'tool', [
          {
            type: 'tool_result',
            toolCallId: item.call_id,
            content: outputParts(item.output, onDrop),
          },
        ]);
        continue;
      }
      // Coding tools (card 31.2): replayed custom / apply_patch calls and their outputs.
      if (item.type === 'custom_tool_call' || item.type === 'apply_patch_call') {
        const call = codingCallIn(item);
        if (call) append(messages, 'assistant', [call]);
        else onDrop('input[]', `${item.type} without call_id or name`);
        continue;
      }
      if (item.type === 'custom_tool_call_output' && item.call_id) {
        append(messages, 'tool', [
          {
            type: 'tool_result',
            toolCallId: item.call_id,
            content: outputParts(item.output, onDrop),
          },
        ]);
        continue;
      }
      if (item.type === 'apply_patch_call_output' && item.call_id) {
        const { text, isError } = applyPatchOutputIn(item);
        append(messages, 'tool', [
          {
            type: 'tool_result',
            toolCallId: item.call_id,
            content: [{ type: 'text', text }],
            ...(isError ? { isError: true } : {}),
          },
        ]);
        continue;
      }
      if (item.type === 'reasoning') {
        const text = (item.summary ?? [])
          .map((part) => part.text ?? '')
          .filter(Boolean)
          .join('\n');
        if (text) append(messages, 'assistant', [{ type: 'reasoning', text }]);
        else onDrop('input[]', 'reasoning item without summary text');
        continue;
      }
      // Anything else with an explicit type (built-in tool calls, custom tool calls, …) has no
      // canonical representation; skip it instead of failing the request.
      if (item.type !== undefined && item.type !== 'message') {
        onDrop('input[]', `unsupported item '${item.type}'`);
        continue;
      }
      const role = item.role ?? (item.type === 'message' ? 'user' : undefined);
      if (role === 'system' || role === 'developer') {
        if (typeof item.content === 'string') system.push({ type: 'text', text: item.content });
        else
          system.push(
            ...itemParts(item, onDrop).filter((p): p is CanonicalTextPart => p.type === 'text'),
          );
        continue;
      }
      if (role === 'tool') {
        if (item.call_id)
          append(messages, 'tool', [
            {
              type: 'tool_result',
              toolCallId: item.call_id,
              content: outputParts(item.output, onDrop),
            },
          ]);
        continue;
      }
      if (role === 'assistant') {
        append(messages, 'assistant', itemParts(item, onDrop));
        continue;
      }
      if (role !== 'user') {
        onDrop('input[]', `unsupported item '${role ?? 'unknown'}'`);
        continue;
      }
      messages.push({ role, content: itemParts(item, onDrop) });
    }
  }

  const tools: CanonicalTool[] = [];
  const serverTools: NonNullable<CanonicalRequest['serverTools']> = [];
  for (const tool of req.tools ?? []) {
    // Responses tools are flat; the nested Chat Completions form is tolerated.
    const fn = tool.function ?? tool;
    const coding = codingToolIn(tool);
    if (coding) {
      tools.push(coding);
      continue;
    }
    // Card 31.7: web search and the code interpreter run by the provider.
    const server = responsesServerToolIn(tool);
    if (server) {
      serverTools.push(server);
      continue;
    }
    if (tool.type !== 'function' || !fn.name) {
      onDrop('tools[]', `unsupported tool type '${tool.type}'`);
      continue;
    }
    tools.push({
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters: fn.parameters ?? { type: 'object' },
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    });
  }

  let toolChoice: CanonicalToolChoice | undefined;
  if (typeof req.tool_choice === 'string') toolChoice = req.tool_choice;
  else if (req.tool_choice) {
    if (
      (req.tool_choice.type === 'function' || req.tool_choice.type === 'custom') &&
      req.tool_choice.name
    )
      toolChoice = { name: req.tool_choice.name };
    else if (req.tool_choice.type === 'apply_patch') toolChoice = { name: 'apply_patch' };
    else onDrop('tool_choice', `unsupported tool choice '${req.tool_choice.type}'`);
  }

  const format = req.text?.format;
  const responseFormat =
    format?.type === 'json_object'
      ? { type: 'json_object' as const }
      : format?.type === 'json_schema' && format.name && format.schema
        ? {
            type: 'json_schema' as const,
            name: format.name,
            schema: format.schema,
            ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
          }
        : format?.type === 'text'
          ? { type: 'text' as const }
          : undefined;

  const requestedEffort = req.reasoning?.effort;
  const effort = requestedEffort ? EFFORT_TO_CANONICAL[requestedEffort] : undefined;
  if (requestedEffort && !effort)
    onDrop('reasoning.effort', `'${requestedEffort}' has no canonical equivalent`);

  return {
    inboundApi: 'openai.responses',
    model: req.model,
    system,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(typeof req.parallel_tool_calls === 'boolean'
      ? { parallelToolCalls: req.parallel_tool_calls }
      : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(typeof req.max_output_tokens === 'number'
      ? { maxOutputTokens: req.max_output_tokens }
      : {}),
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.top_p === 'number' ? { topP: req.top_p } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(serviceTierIn((req as { service_tier?: unknown }).service_tier)
      ? { serviceTier: serviceTierIn((req as { service_tier?: unknown }).service_tier) }
      : {}),
    stream: req.stream === true,
    ...(req.user ? { user: req.user } : {}),
    ...(req.metadata ? { metadata: req.metadata } : {}),
    ...(serverTools.length ? { serverTools } : {}),
    ...responsesLogprobs(req),
  };
}

/** `include: ["message.output_text.logprobs"]` and `top_logprobs` → canonical (card 31.7). */
function responsesLogprobs(req: ResponsesRequest): Pick<CanonicalRequest, 'logprobs'> {
  const r = req as { include?: unknown; top_logprobs?: unknown };
  const top = typeof r.top_logprobs === 'number' ? r.top_logprobs : undefined;
  const included = Array.isArray(r.include) && r.include.includes('message.output_text.logprobs');
  if (!included && top === undefined) return {};
  return { logprobs: top !== undefined ? { top } : {} };
}

type ResponseStatus = 'completed' | 'incomplete' | 'failed';

const FINISH_TO_RESPONSE: Record<CanonicalResponse['finishReason'], ResponseStatus> = {
  stop: 'completed',
  length: 'incomplete',
  tool_calls: 'completed',
  content_filter: 'incomplete',
  refusal: 'incomplete',
  error: 'failed',
  other: 'completed',
};

/** Terminal fields (`incomplete_details`, `error`) that go with a finish reason. */
function terminalFields(finish: CanonicalResponse['finishReason']) {
  const status = FINISH_TO_RESPONSE[finish];
  return {
    status,
    error:
      status === 'failed'
        ? { code: 'server_error', message: 'The provider ended the response with an error.' }
        : null,
    incomplete_details:
      status === 'incomplete'
        ? { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' }
        : null,
  };
}

export function responsesUsage(usage: CanonicalUsage) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens },
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

type OutputItem = Record<string, unknown>;

const outputTextPart = (text: string, annotations: unknown[] = [], logprobs?: unknown[]) => ({
  type: 'output_text',
  text,
  annotations,
  ...(logprobs ? { logprobs } : {}),
});

function messageItem(
  id: string,
  text: string,
  status: string,
  annotations: unknown[] = [],
  logprobs?: unknown[],
): OutputItem {
  return {
    type: 'message',
    id,
    status,
    role: 'assistant',
    content: status === 'in_progress' ? [] : [outputTextPart(text, annotations, logprobs)],
  };
}

function reasoningItem(id: string, text: string, status: string): OutputItem {
  return {
    type: 'reasoning',
    id,
    status,
    summary: status === 'in_progress' ? [] : [{ type: 'summary_text', text }],
  };
}

function functionCallItem(callId: string, name: string, args: string, status: string): OutputItem {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: status === 'in_progress' ? args : args || '{}',
    status,
  };
}

/**
 * Output items follow the order of the canonical content; adjacent text parts form one message.
 * Item ids carry the position so they match the ids used by the stream encoder.
 */
export function canonicalToResponsesResponse(
  response: CanonicalResponse,
  options: { model: string; tools?: readonly CanonicalTool[] | undefined },
) {
  const output: OutputItem[] = [];
  const texts: string[] = [];
  let openMessage: { index: number; text: string; parts: CanonicalPart[] } | undefined;
  const logprobs = response.logprobs ? openAILogprobsOut(response.logprobs) : undefined;
  const closeMessage = () => {
    if (!openMessage) return;
    const id = `msg_${response.id}_${String(openMessage.index)}`;
    // Card 31.7: url citations as annotations; log probabilities on the answer's text.
    output[openMessage.index] = messageItem(
      id,
      openMessage.text,
      'completed',
      responsesAnnotationsOut(openMessage.parts),
      logprobs,
    );
    openMessage = undefined;
  };
  for (const part of response.content) {
    if (part.type === 'text') {
      if (part.text === '') continue;
      texts.push(part.text);
      if (openMessage) {
        openMessage.text += part.text;
        openMessage.parts.push(part);
      } else {
        openMessage = { index: output.length, text: part.text, parts: [part] };
        output.push({});
      }
    } else if (part.type === 'reasoning') {
      closeMessage();
      output.push(
        reasoningItem(`rs_${response.id}_${String(output.length)}`, part.text, 'completed'),
      );
    } else if (part.type === 'tool_call') {
      closeMessage();
      output.push(
        codingOutputItem(part, codingKindOf(part.name, options.tools), 'completed') ??
          functionCallItem(part.id, part.name, part.arguments, 'completed'),
      );
    }
  }
  closeMessage();
  return {
    id: `resp_${response.id}`,
    object: 'response',
    created_at: response.created,
    model: options.model,
    output,
    output_text: texts.join(''),
    ...(response.usage ? { usage: responsesUsage(response.usage) } : {}),
    ...terminalFields(response.finishReason),
  };
}

type OpenItem =
  | {
      kind: 'message';
      outputIndex: number;
      id: string;
      text: string;
      /** Url citations as Responses annotations (card 31.7). */
      annotations: Record<string, unknown>[];
      /** Where each canonical text block began in `text`. */
      blockStart: Map<number, number>;
    }
  | { kind: 'reasoning'; outputIndex: number; id: string; text: string; canonical: number }
  | {
      kind: 'function_call';
      outputIndex: number;
      id: string;
      callId: string;
      name: string;
      args: string;
      canonical: number;
      /** A translated coding tool (card 31.2): announced and finished as its own item type. */
      coding?: 'custom' | 'apply_patch';
    };

/**
 * canonical stream → Responses API SSE events.
 *
 * The sequence mirrors the upstream API: `response.created`, `response.in_progress`, then per
 * output item `response.output_item.added` … `response.output_item.done`, and finally one terminal
 * event (`response.completed`, `response.incomplete` or `response.failed`). Every event carries an
 * increasing `sequence_number`, and `output_index` is the item's position in the final `output`.
 */
export class ResponsesStreamEncoder {
  readonly #model: string;
  readonly #tools: readonly CanonicalTool[] | undefined;
  #base = 'dirouter';
  #created = Math.floor(Date.now() / 1000);
  #usage: CanonicalUsage | undefined;
  #finish: CanonicalResponse['finishReason'] = 'stop';
  #sequence = 0;
  #begun = false;
  #done = false;
  #text = '';
  /** Finished and in-progress items by output index. */
  readonly #output: OutputItem[] = [];
  #open: OpenItem[] = [];

  constructor(options: { model: string; tools?: readonly CanonicalTool[] | undefined }) {
    this.#model = options.model;
    this.#tools = options.tools;
  }

  get usage(): CanonicalUsage | undefined {
    return this.#usage;
  }

  push(event: CanonicalStreamEvent): string {
    if (this.#done) return '';
    switch (event.type) {
      case 'start':
        if (this.#begun) return '';
        this.#base = event.id;
        this.#created = event.created;
        return this.#begin();
      case 'text_delta': {
        if (event.text === '') return '';
        let out = '';
        let item = this.#open.find((open) => open.kind === 'message');
        if (!item) {
          out += this.#closeWhere((open) => open.kind !== 'function_call');
          const outputIndex = this.#output.length;
          item = {
            kind: 'message',
            outputIndex,
            id: `msg_${this.#base}_${String(outputIndex)}`,
            text: '',
            annotations: [],
            blockStart: new Map(),
          };
          out += this.#add(item, messageItem(item.id, '', 'in_progress'));
          out += this.#emit('response.content_part.added', {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part: outputTextPart(''),
          });
        }
        if (!item.blockStart.has(event.index)) item.blockStart.set(event.index, item.text.length);
        item.text += event.text;
        this.#text += event.text;
        return (
          out +
          this.#emit('response.output_text.delta', {
            item_id: item.id,
            output_index: item.outputIndex,
            content_index: 0,
            delta: event.text,
            logprobs: [],
          })
        );
      }
      case 'reasoning_delta': {
        if (!event.text) return '';
        let out = '';
        let item = this.#open.find(
          (open) => open.kind === 'reasoning' && open.canonical === event.index,
        );
        if (!item) {
          out += this.#closeWhere((open) => open.kind !== 'function_call');
          const outputIndex = this.#output.length;
          item = {
            kind: 'reasoning',
            outputIndex,
            id: `rs_${this.#base}_${String(outputIndex)}`,
            text: '',
            canonical: event.index,
          };
          out += this.#add(item, reasoningItem(item.id, '', 'in_progress'));
          out += this.#emit('response.reasoning_summary_part.added', {
            item_id: item.id,
            output_index: outputIndex,
            summary_index: 0,
            part: { type: 'summary_text', text: '' },
          });
        }
        if (item.kind === 'reasoning') item.text += event.text;
        return (
          out +
          this.#emit('response.reasoning_summary_text.delta', {
            item_id: item.id,
            output_index: item.outputIndex,
            summary_index: 0,
            delta: event.text,
          })
        );
      }
      case 'tool_call_start': {
        // Message and reasoning items end when a call starts; other calls may still be streaming.
        const closed = this.#closeWhere((open) => open.kind !== 'function_call');
        const coding = codingKindOf(event.name, this.#tools);
        const outputIndex = this.#output.length;
        const item: OpenItem = {
          kind: 'function_call',
          outputIndex,
          id:
            coding === 'custom'
              ? `ctc_${event.id}`
              : coding === 'apply_patch'
                ? `apc_${event.id}`
                : `fc_${event.id}`,
          callId: event.id,
          name: event.name,
          args: '',
          canonical: event.index,
          ...(coding ? { coding } : {}),
        };
        if (coding === 'custom')
          return (
            closed +
            this.#add(item, {
              type: 'custom_tool_call',
              id: item.id,
              call_id: event.id,
              name: event.name,
              input: '',
              status: 'in_progress',
            })
          );
        if (coding === 'apply_patch') {
          // The operation is only known once the arguments are complete: announced on close.
          this.#output[outputIndex] = {};
          this.#open.push(item);
          return closed + this.#begin();
        }
        return closed + this.#add(item, functionCallItem(event.id, event.name, '', 'in_progress'));
      }
      case 'tool_call_delta': {
        const item = this.#open.find(
          (open) => open.kind === 'function_call' && open.canonical === event.index,
        );
        if (item?.kind !== 'function_call' || event.argumentsDelta === '') return '';
        item.args += event.argumentsDelta;
        // Coding tools carry JSON arguments here; their own input is sent whole on close.
        if (item.coding) return '';
        return this.#emit('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: item.outputIndex,
          delta: event.argumentsDelta,
        });
      }
      case 'citation': {
        const item = this.#open.find((open) => open.kind === 'message');
        if (item?.kind !== 'message' || event.citation.kind !== 'url') return '';
        const start = item.blockStart.get(event.index) ?? item.text.length;
        const annotation = {
          type: 'url_citation',
          url: event.citation.url,
          title: event.citation.title ?? event.citation.url,
          start_index: start + (event.citation.start ?? 0),
          end_index:
            event.citation.end !== undefined ? start + event.citation.end : item.text.length,
        };
        item.annotations.push(annotation);
        return this.#emit('response.output_text.annotation.added', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          annotation_index: item.annotations.length - 1,
          annotation,
        });
      }
      case 'content_end':
        // A message stays open until another item starts or the stream ends, because the gateway
        // may still append held-back text to it after the provider closed the block.
        return this.#closeWhere(
          (open) => open.kind !== 'message' && open.canonical === event.index,
        );
      case 'usage':
        this.#usage = event.usage;
        return '';
      case 'finish':
        this.#finish = event.finishReason;
        return this.#closeWhere((open) => open.kind !== 'message');
      case 'error':
        this.#done = true;
        return this.#emit('response.failed', {
          response: {
            ...this.#response('failed'),
            error: { code: event.code, message: event.message },
          },
        });
      default:
        return '';
    }
  }

  /** Closes the items that are still open and emits the terminal event. */
  end(): string {
    if (this.#done) return '';
    let out = this.#begin();
    out += this.#closeWhere(() => true);
    this.#done = true;
    const terminal = terminalFields(this.#finish);
    return (
      out +
      this.#emit(`response.${terminal.status}`, {
        response: {
          ...this.#response(terminal.status),
          ...terminal,
          output_text: this.#text,
          usage: responsesUsage(this.#usage ?? emptyUsage()),
        },
      })
    );
  }

  /** `response.created` and `response.in_progress`, once, before any other event. */
  #begin(): string {
    if (this.#begun) return '';
    this.#begun = true;
    return (
      this.#emit('response.created', { response: this.#response('in_progress') }) +
      this.#emit('response.in_progress', { response: this.#response('in_progress') })
    );
  }

  #add(item: OpenItem, wire: OutputItem): string {
    const begun = this.#begin();
    this.#open.push(item);
    this.#output[item.outputIndex] = wire;
    return (
      begun +
      this.#emit('response.output_item.added', { output_index: item.outputIndex, item: wire })
    );
  }

  #closeWhere(match: (item: OpenItem) => boolean): string {
    const closing = this.#open.filter(match);
    if (closing.length === 0) return '';
    this.#open = this.#open.filter((item) => !closing.includes(item));
    return closing.map((item) => this.#close(item)).join('');
  }

  #close(item: OpenItem): string {
    const at = { item_id: item.id, output_index: item.outputIndex };
    let out = '';
    let wire: OutputItem;
    if (item.kind === 'message') {
      wire = messageItem(item.id, item.text, 'completed', item.annotations);
      out += this.#emit('response.output_text.done', {
        ...at,
        content_index: 0,
        text: item.text,
        logprobs: [],
      });
      out += this.#emit('response.content_part.done', {
        ...at,
        content_index: 0,
        part: outputTextPart(item.text, item.annotations),
      });
    } else if (item.kind === 'reasoning') {
      wire = reasoningItem(item.id, item.text, 'completed');
      out += this.#emit('response.reasoning_summary_text.done', {
        ...at,
        summary_index: 0,
        text: item.text,
      });
      out += this.#emit('response.reasoning_summary_part.done', {
        ...at,
        summary_index: 0,
        part: { type: 'summary_text', text: item.text },
      });
    } else if (item.coding) {
      const call = { id: item.callId, name: item.name, arguments: item.args };
      const coded = codingOutputItem(call, item.coding, 'completed');
      if (coded && item.coding === 'custom') {
        const input = customInputOf(item.args);
        out += this.#emit('response.custom_tool_call_input.delta', { ...at, delta: input });
        out += this.#emit('response.custom_tool_call_input.done', { ...at, input });
      }
      wire = coded ?? functionCallItem(item.callId, item.name, item.args, 'completed');
      if (!coded) wire = { ...wire, id: item.id };
      if (item.coding === 'apply_patch')
        out += this.#emit('response.output_item.added', {
          output_index: item.outputIndex,
          item: { ...wire, status: 'in_progress' },
        });
    } else {
      wire = functionCallItem(item.callId, item.name, item.args, 'completed');
      out += this.#emit('response.function_call_arguments.done', {
        ...at,
        name: item.name,
        arguments: item.args || '{}',
      });
    }
    this.#output[item.outputIndex] = wire;
    return (
      out + this.#emit('response.output_item.done', { output_index: item.outputIndex, item: wire })
    );
  }

  #response(status: string) {
    return {
      id: `resp_${this.#base}`,
      object: 'response',
      created_at: this.#created,
      status,
      model: this.#model,
      output: [...this.#output],
      error: null,
      incomplete_details: null,
    };
  }

  #emit(event: string, data: Record<string, unknown>): string {
    return encodeSse({
      event,
      data: JSON.stringify({ type: event, sequence_number: this.#sequence++, ...data }),
    });
  }
}

/** Provider-side finish reasons arrive as Responses strings in some SDKs. */
export function responsesFinishToCanonical(reason: string | null | undefined) {
  return FINISH_FROM_RESPONSES[reason ?? ''] ?? 'stop';
}
