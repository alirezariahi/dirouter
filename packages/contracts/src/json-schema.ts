/**
 * خروجی JSON Schema برای مستندات و مصرف‌کننده‌های غیر TypeScript.
 */
import { z } from 'zod';

import {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
} from './anthropic/messages.js';
import { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from './canonical.js';
import { ConfigSnapshot } from './config-snapshot.js';
import { AnthropicErrorBody, OpenAIErrorBody, ProblemDetails } from './errors.js';
import {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
} from './openai/chat.js';
import { UsageEvent } from './usage-event.js';

export const schemaRegistry = {
  'openai.chat-completion-request': OpenAIChatCompletionRequest,
  'openai.chat-completion-response': OpenAIChatCompletionResponse,
  'openai.chat-completion-chunk': OpenAIChatCompletionChunk,
  'anthropic.messages-request': AnthropicMessagesRequest,
  'anthropic.messages-response': AnthropicMessagesResponse,
  'anthropic.stream-event': AnthropicStreamEvent,
  'canonical.request': CanonicalRequest,
  'canonical.response': CanonicalResponse,
  'canonical.stream-event': CanonicalStreamEvent,
  'config-snapshot': ConfigSnapshot,
  'usage-event': UsageEvent,
  'error.problem-details': ProblemDetails,
  'error.openai': OpenAIErrorBody,
  'error.anthropic': AnthropicErrorBody,
} as const satisfies Record<string, z.ZodType>;

export type SchemaName = keyof typeof schemaRegistry;

/** JSON Schema (draft 2020-12) یک اسکیمای ثبت‌شده. */
export function toJsonSchema(name: SchemaName): Record<string, unknown> {
  return z.toJSONSchema(schemaRegistry[name], { target: 'draft-2020-12', io: 'input' });
}
