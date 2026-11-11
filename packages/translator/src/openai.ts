/**
 * OpenAI Chat Completions ⇄ canonical.
 *
 * - Inbound: OpenAI client request → canonical, and canonical response → OpenAI response.
 * - Outbound: canonical → request to an OpenAI-compatible provider, and its response → canonical.
 */
import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTextPart,
  CanonicalToolChoice,
  CanonicalUsage,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatMessage,
  OpenAIFinishReason,
  OpenAIToolCall,
  OpenAIUsage,
} from '@dirouter/contracts';

import {
  type DropReporter,
  emptyUsage,
  type FinishReasonMap,
  ignoreDrops,
  imageFromUrl,
  imageToUrl,
  textOf,
  type TranslateOptions,
} from './common.js';

/** OpenAI request fields that are translated directly; the rest are passed through. */
const CONSUMED_REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'user',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'reasoning_effort',
  'metadata',
  'n',
]);

type TextLike =
  string | readonly { type: string; text?: string; refusal?: string }[] | null | undefined;

function textParts(content: TextLike): CanonicalTextPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  return content.flatMap((p): CanonicalTextPart[] => {
    if (p.type === 'text' && typeof p.text === 'string') return [{ type: 'text', text: p.text }];
    if (p.type === 'refusal' && typeof p.refusal === 'string')
      return [{ type: 'text', text: p.refusal }];
    return [];
  });
}

function userParts(
  message: Extract<OpenAIChatMessage, { role: 'user' }>,
  onDrop: DropReporter,
): CanonicalPart[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return message.content.flatMap((part): CanonicalPart[] => {
    switch (part.type) {
      case 'text':
        return [{ type: 'text', text: part.text }];
      case 'image_url':
        return [
          {
            type: 'image',
            source: imageFromUrl(part.image_url.url),
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
          },
        ];
      default:
        onDrop(
          `messages[].content[].${part.type}`,
          'content type not supported by canonical model',
        );
        return [];
    }
  });
}

function toolChoiceIn(
  choice: OpenAIChatCompletionRequest['tool_choice'],
): CanonicalToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') return choice;
  return { name: choice.function.name };
}

export function openAIRequestToCanonical(
  req: OpenAIChatCompletionRequest,
  options: TranslateOptions = {},
): CanonicalRequest {
  const onDrop = options.onDrop ?? ignoreDrops;
  const system: CanonicalTextPart[] = [];
  const messages: CanonicalMessage[] = [];

  for (const message of req.messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        system.push(...textParts(message.content));
        break;
      case 'user':
        messages.push({
          role: 'user',
          content: userParts(message, onDrop),
          ...(message.name ? { name: message.name } : {}),
        });
        break;
      case 'assistant': {
        const content: CanonicalPart[] = textParts(message.content ?? null);
        if (message.refusal) content.push({ type: 'text', text: message.refusal });
        for (const call of message.tool_calls ?? []) {
          content.push({
            type: 'tool_call',
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        messages.push({ role: 'assistant', content });
        break;
      }
      case 'tool':
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: message.tool_call_id,
              content: textParts(message.content),
            },
          ],
        });
        break;
    }
  }

  if (req.n !== undefined && req.n !== null && req.n > 1) onDrop('n', 'only n=1 is supported');

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req)) {
    if (!CONSUMED_REQUEST_FIELDS.has(key) && value !== undefined) passthrough[key] = value;
  }

  const stop =
    req.stop === null || req.stop === undefined
      ? undefined
      : typeof req.stop === 'string'
        ? [req.stop]
        : req.stop;
  const maxOutputTokens = req.max_completion_tokens ?? req.max_tokens ?? undefined;
  const toolChoice = toolChoiceIn(req.tool_choice);
  const format = req.response_format;

  return {
    inboundApi: 'openai.chat',
    model: req.model,
    system,
    messages,
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.function.name,
            ...(t.function.description !== undefined
              ? { description: t.function.description }
              : {}),
            parameters: t.function.parameters ?? { type: 'object', properties: {} },
            ...(typeof t.function.strict === 'boolean' ? { strict: t.function.strict } : {}),
          })),
        }
      : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(req.parallel_tool_calls !== undefined
      ? { parallelToolCalls: req.parallel_tool_calls }
      : {}),
    ...(format
      ? {
          responseFormat:
            format.type === 'json_schema'
              ? {
                  type: 'json_schema',
                  name: format.json_schema.name,
                  schema: format.json_schema.schema ?? {},
                  ...(typeof format.json_schema.strict === 'boolean'
                    ? { strict: format.json_schema.strict }
                    : {}),
                }
              : { type: format.type },
        }
      : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.top_p === 'number' ? { topP: req.top_p } : {}),
    ...(stop ? { stop } : {}),
    ...(typeof req.seed === 'number' ? { seed: req.seed } : {}),
    ...(req.reasoning_effort ? { reasoning: { effort: req.reasoning_effort } } : {}),
    stream: req.stream === true,
    ...(req.user !== undefined ? { user: req.user } : {}),
    ...(req.metadata ? { metadata: req.metadata } : {}),
    ...(Object.keys(passthrough).length > 0 ? { passthrough } : {}),
  };
}

// ───────────── canonical → OpenAI request (provider) ─────────────

export interface ToOpenAIRequestOptions extends TranslateOptions {
  /** Model name at the provider. */
  upstreamModel: string;
  /**
   * Native OpenAI requires `max_completion_tokens`; many compatible servers only
   * understand `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
}

const EFFORT_FROM_BUDGET = (budget: number): 'low' | 'medium' | 'high' =>
  budget < 4_096 ? 'low' : budget < 16_384 ? 'medium' : 'high';

function openAIUserContent(parts: readonly CanonicalPart[], onDrop: DropReporter) {
  const out: (
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  )[] = [];
  for (const part of parts) {
    if (part.type === 'text') out.push({ type: 'text', text: part.text });
    else if (part.type === 'image')
      out.push({
        type: 'image_url',
        image_url: {
          url: imageToUrl(part.source),
          ...(part.detail ? { detail: part.detail } : {}),
        },
      });
    else onDrop(`messages[].content.${part.type}`, 'not representable in an OpenAI user message');
  }
  const only = out[0];
  return out.length === 1 && only?.type === 'text' ? only.text : out;
}

function toolResultText(parts: readonly CanonicalPart[], onDrop: DropReporter): string {
  if (parts.some((p) => p.type !== 'text'))
    onDrop('tool_result.content.image', 'OpenAI tool messages are text-only');
  return textOf(parts);
}

export function canonicalToOpenAIRequest(
  req: CanonicalRequest,
  options: ToOpenAIRequestOptions,
): Record<string, unknown> {
  const onDrop = options.onDrop ?? ignoreDrops;
  const messages: Record<string, unknown>[] = [];
  if (req.system.length > 0)
    messages.push({ role: 'system', content: req.system.map((p) => p.text).join('\n\n') });

  for (const message of req.messages) {
    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: openAIUserContent(message.content, onDrop),
        ...(message.name ? { name: message.name } : {}),
      });
    } else if (message.role === 'assistant') {
      const toolCalls: OpenAIToolCall[] = [];
      let text = '';
      for (const part of message.content) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'tool_call')
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: part.arguments },
          });
        else if (part.type === 'reasoning')
          onDrop('assistant.reasoning', 'OpenAI chat has no reasoning input');
        else onDrop(`assistant.${part.type}`, 'not representable in an OpenAI assistant message');
      }
      messages.push({
        role: 'assistant',
        content: text === '' && toolCalls.length > 0 ? null : text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const part of message.content) {
        if (part.type === 'tool_result')
          messages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: toolResultText(part.content, onDrop),
          });
      }
    }
  }

  const body: Record<string, unknown> = {};
  // Passthrough only makes sense when the input was also OpenAI.
  if (req.inboundApi === 'openai.chat' && req.passthrough) Object.assign(body, req.passthrough);
  Object.assign(body, { model: options.upstreamModel, messages });

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: t.parameters,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
  }
  if (req.toolChoice !== undefined) {
    body.tool_choice =
      typeof req.toolChoice === 'string'
        ? req.toolChoice
        : { type: 'function', function: { name: req.toolChoice.name } };
  }
  if (req.parallelToolCalls !== undefined && req.tools?.length)
    body.parallel_tool_calls = req.parallelToolCalls;
  if (req.responseFormat) {
    body.response_format =
      req.responseFormat.type === 'json_schema'
        ? {
            type: 'json_schema',
            json_schema: {
              name: req.responseFormat.name,
              schema: req.responseFormat.schema,
              ...(req.responseFormat.strict !== undefined
                ? { strict: req.responseFormat.strict }
                : {}),
            },
          }
        : { type: req.responseFormat.type };
  }
  if (req.maxOutputTokens !== undefined)
    body[options.maxTokensField ?? 'max_tokens'] = req.maxOutputTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.topK !== undefined) onDrop('top_k', 'OpenAI has no top_k');
  if (req.stop?.length) body.stop = req.stop;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.user !== undefined) body.user = req.user;
  if (req.metadata && req.inboundApi === 'openai.chat') body.metadata = req.metadata;
  if (req.reasoning?.effort) body.reasoning_effort = req.reasoning.effort;
  else if (req.reasoning?.budgetTokens !== undefined)
    body.reasoning_effort = EFFORT_FROM_BUDGET(req.reasoning.budgetTokens);
  if (req.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

// ───────────── OpenAI response → canonical ─────────────

const FINISH_IN: Readonly<Record<string, CanonicalFinishReason | undefined>> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'content_filter',
} satisfies Record<OpenAIFinishReason, CanonicalFinishReason>;

export function openAIFinishToCanonical(reason: string | null | undefined): CanonicalFinishReason {
  if (!reason) return 'other';
  return FINISH_IN[reason] ?? 'other';
}

export function openAIUsageToCanonical(usage: OpenAIUsage | null | undefined): CanonicalUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

export function openAIResponseToCanonical(res: OpenAIChatCompletionResponse): CanonicalResponse {
  const choice = res.choices[0];
  const content: CanonicalPart[] = [];
  let finishReason = openAIFinishToCanonical(choice?.finish_reason);
  if (choice) {
    // Some compatible providers return reasoning text in reasoning_content.
    const reasoning = (choice.message as { reasoning_content?: unknown }).reasoning_content;
    if (typeof reasoning === 'string' && reasoning !== '')
      content.push({ type: 'reasoning', text: reasoning });
    if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
    if (choice.message.refusal) {
      content.push({ type: 'text', text: choice.message.refusal });
      finishReason = 'refusal';
    }
    for (const call of choice.message.tool_calls ?? []) {
      content.push({
        type: 'tool_call',
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return {
    id: res.id,
    model: res.model,
    content,
    finishReason,
    ...(choice?.finish_reason ? { rawFinishReason: choice.finish_reason } : {}),
    ...(res.usage ? { usage: openAIUsageToCanonical(res.usage) } : {}),
    created: res.created,
  };
}

// ───────────── canonical → OpenAI response (client) ─────────────

export const FINISH_TO_OPENAI: FinishReasonMap<OpenAIFinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
  refusal: 'stop',
  error: 'stop',
  other: 'stop',
};

export function canonicalUsageToOpenAI(usage: CanonicalUsage): OpenAIUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

export function canonicalToOpenAIResponse(
  res: CanonicalResponse,
  options: { model: string },
): OpenAIChatCompletionResponse {
  const toolCalls: OpenAIToolCall[] = [];
  let text = '';
  for (const part of res.content) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'tool_call')
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      });
  }
  const refusal = res.finishReason === 'refusal';
  return {
    id: res.id.startsWith('chatcmpl-') ? res.id : `chatcmpl-${res.id}`,
    object: 'chat.completion',
    created: res.created,
    model: options.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: refusal ? null : text === '' && toolCalls.length > 0 ? null : text,
          refusal: refusal ? text : null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: FINISH_TO_OPENAI[res.finishReason],
        logprobs: null,
      },
    ],
    usage: canonicalUsageToOpenAI(res.usage ?? emptyUsage()),
  };
}
