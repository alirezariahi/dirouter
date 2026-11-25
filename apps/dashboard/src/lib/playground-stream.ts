/**
 * Streamed playground (card 25.6): the server-sent events control-api relays from the gateway
 * (`meta`, `ttft`, `chunk`, `error`, `end`), folded into one column per model, and the request
 * body built from the form. Pure functions, tested without a browser stream.
 */
import type { PlaygroundControllerStreamBody } from '../api/generated';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Column {
  model: string;
  state: 'streaming' | 'done' | 'error';
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  status?: number;
  headers: Record<string, string>;
  ttftMs?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: string;
  finishReason?: string;
  error?: { code?: string; message: string };
}

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export const emptyColumn = (model: string): Column => ({
  model,
  state: 'streaming',
  text: '',
  reasoning: '',
  toolCalls: [],
  headers: {},
});

/** Complete events in `buffer`, and what is left for the next read. */
export function parseSse(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const rest = frames.pop() ?? '';
  for (const frame of frames) {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) as Record<string, unknown> });
    } catch {
      // A malformed frame is skipped; the stream goes on.
    }
  }
  return { events, rest };
}

interface Delta {
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

const num = (value: unknown) => (typeof value === 'number' ? value : undefined);

/** One event folded into the column it belongs to. */
export function applyEvent(column: Column, { event, data }: StreamEvent): Column {
  switch (event) {
    case 'meta':
      return {
        ...column,
        ...(num(data.status) !== undefined ? { status: num(data.status) } : {}),
        headers: (data.headers as Record<string, string> | undefined) ?? {},
      };
    case 'ttft':
      return { ...column, ...(num(data.ms) !== undefined ? { ttftMs: num(data.ms) } : {}) };
    case 'chunk': {
      const choice = (
        data.choices as { delta?: Delta; finish_reason?: string | null }[] | undefined
      )?.[0];
      const delta = choice?.delta;
      const next = { ...column };
      if (typeof delta?.content === 'string') next.text += delta.content;
      if (typeof delta?.reasoning_content === 'string') next.reasoning += delta.reasoning_content;
      if (delta?.tool_calls) {
        const calls = [...next.toolCalls];
        for (const part of delta.tool_calls) {
          const index = part.index ?? calls.length;
          const current = calls[index] ?? { id: '', name: '', arguments: '' };
          calls[index] = {
            id: part.id ?? current.id,
            name: part.function?.name ?? current.name,
            arguments: current.arguments + (part.function?.arguments ?? ''),
          };
        }
        next.toolCalls = calls;
      }
      if (choice?.finish_reason) next.finishReason = choice.finish_reason;
      return next;
    }
    case 'error':
      return {
        ...column,
        state: 'error',
        error: {
          ...(typeof data.code === 'string' ? { code: data.code } : {}),
          message: typeof data.message === 'string' ? data.message : 'error',
        },
      };
    case 'end':
      return {
        ...column,
        state: column.state === 'error' ? 'error' : 'done',
        ...(num(data.latencyMs) !== undefined ? { latencyMs: num(data.latencyMs) } : {}),
        ...(num(data.ttftMs) !== undefined ? { ttftMs: num(data.ttftMs) } : {}),
        ...(num(data.inputTokens) !== undefined ? { inputTokens: num(data.inputTokens) } : {}),
        ...(num(data.outputTokens) !== undefined ? { outputTokens: num(data.outputTokens) } : {}),
        ...(typeof data.estimatedCostUsd === 'string'
          ? { estimatedCostUsd: data.estimatedCostUsd }
          : {}),
      };
    default:
      return column;
  }
}

export const EXAMPLE_TOOLS = JSON.stringify(
  [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather of a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ],
  null,
  2,
);

type Tools = NonNullable<PlaygroundControllerStreamBody['tools']>;

/** Tool definitions typed as JSON: an array of OpenAI function tools, or the reason it is not. */
export function parseTools(
  text: string,
): { ok: true; tools: Tools } | { ok: false; error: 'json' | 'shape' } {
  if (!text.trim()) return { ok: true, tools: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json' };
  }
  const valid =
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        (tool as { type?: unknown }).type === 'function' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(
          String((tool as { function?: { name?: unknown } }).function?.name),
        ),
    );
  return valid ? { ok: true, tools: value as Tools } : { ok: false, error: 'shape' };
}

export interface PlaygroundForm {
  apiKey: string;
  system: string;
  prompt: string;
  maxTokens: string;
  temperature: string;
  topP: string;
  reasoningEffort: '' | 'minimal' | 'low' | 'medium' | 'high';
  responseFormat: 'text' | 'json_object' | 'json_schema';
  jsonSchema: string;
  toolChoice: 'auto' | 'none' | 'required';
  image?: string | undefined;
}

/** The body of one streamed call; `tools` and the JSON schema are parsed by the caller. */
export function streamBody(
  form: PlaygroundForm,
  model: string,
  tools: Tools,
  schema: Record<string, unknown> | undefined,
  /** Earlier turns of a replayed request (card 24.1). */
  history?: { role: 'user' | 'assistant'; content: string }[],
): PlaygroundControllerStreamBody {
  return {
    apiKey: form.apiKey.trim(),
    model,
    prompt: form.prompt,
    ...(form.system.trim() ? { system: form.system } : {}),
    ...(history?.length ? { history } : {}),
    ...(form.image ? { image: form.image } : {}),
    maxTokens: Number(form.maxTokens) || 512,
    ...(form.temperature !== '' ? { temperature: Number(form.temperature) } : {}),
    ...(form.topP !== '' ? { topP: Number(form.topP) } : {}),
    ...(form.reasoningEffort ? { reasoningEffort: form.reasoningEffort } : {}),
    ...(form.responseFormat === 'json_schema' && schema
      ? {
          responseFormat: {
            type: 'json_schema' as const,
            json_schema: { name: 'response', schema },
          },
        }
      : form.responseFormat === 'json_object'
        ? { responseFormat: { type: 'json_object' as const } }
        : {}),
    ...(tools.length ? { tools, toolChoice: form.toolChoice } : {}),
  };
}

/** Largest side of an attached image after downsizing, and the cap on the data URL. */
export const IMAGE_MAX_SIDE = 1024;
export const IMAGE_MAX_CHARS = 900_000;
