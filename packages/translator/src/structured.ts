/**
 * Structured output (`response_format`) for providers without OpenAI's JSON mode (card 27.1).
 *
 * Claude models that support structured outputs get the native `output_config.format` field. Older
 * models get a fallback: one extra tool whose input schema is the requested schema, forced with
 * `tool_choice`. The model's call to that tool is turned back into plain text content (the JSON
 * arguments) and the finish reason into `stop`, so the client sees the same answer it would get
 * from OpenAI.
 */
import type {
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalTool,
} from '@dirouter/contracts';

/** Name of the fallback tool. Reserved: a client tool with this name would be unwrapped too. */
export const STRUCTURED_OUTPUT_TOOL = 'dirouter_structured_output';

/** System text used when JSON is requested without a schema the provider can enforce. */
export const JSON_ONLY_INSTRUCTION =
  'Respond with a single valid JSON object and nothing else: no prose and no code fences.';

export type StructuredOutputMode = 'native' | 'tool';

/**
 * Claude families with native structured outputs (`output_config.format`). The match is on a
 * substring so Bedrock ids (`us.anthropic.claude-sonnet-5-5-v1:0`) and dated ids work too. Every
 * model that rejects a forced `tool_choice` (Opus 5.5, Sonnet 5.5, Fable/Mythos 5.1 and later) is
 * in this list, so the forced-tool fallback is only used where it is accepted.
 */
const NATIVE_STRUCTURED_OUTPUT =
  /claude-(?:opus-4-1|opus-4-5|opus-4-8|opus-5|sonnet-5|haiku-4-5|haiku-5|fable|mythos)(?![0-9])/;

/**
 * How a Claude model receives `response_format`. `override` is the provider option
 * `structuredOutput` (`native` or `tool`), for models this list does not know yet.
 */
export function claudeStructuredOutputMode(
  model: string,
  override?: unknown,
): StructuredOutputMode {
  if (override === 'native' || override === 'tool') return override;
  return NATIVE_STRUCTURED_OUTPUT.test(model) ? 'native' : 'tool';
}

/** Claude models that answer a forced `tool_choice` (`any` or `tool`) with a 400. */
const FORCED_TOOL_REJECTED = /claude-(?:opus-5-5|sonnet-5-5|fable-5-[1-9]|mythos-5-[1-9])(?![0-9])/;

/**
 * How a Bedrock (Converse) model receives `response_format`. Converse's forced `toolChoice` is the
 * portable path and the default; models that reject a forced tool get Anthropic's native
 * `output_config.format` through `additionalModelRequestFields`. `override` is the provider option
 * `structuredOutput`.
 */
export function bedrockStructuredOutputMode(
  model: string,
  override?: unknown,
): StructuredOutputMode {
  if (override === 'native' || override === 'tool') return override;
  return FORCED_TOOL_REJECTED.test(model) ? 'native' : 'tool';
}

/** The JSON schema the model must follow; `json_object` means "any JSON object". */
export function structuredOutputSchema(
  format: NonNullable<CanonicalRequest['responseFormat']>,
): Record<string, unknown> | undefined {
  if (format.type === 'json_schema') return format.schema;
  if (format.type === 'json_object') return { type: 'object' };
  return undefined;
}

/** The fallback tool for a request with a JSON `response_format`, or undefined. */
export function structuredOutputTool(
  format: CanonicalRequest['responseFormat'],
): CanonicalTool | undefined {
  if (!format) return undefined;
  const schema = structuredOutputSchema(format);
  if (!schema) return undefined;
  const name = format.type === 'json_schema' ? format.name : 'json_object';
  return {
    name: STRUCTURED_OUTPUT_TOOL,
    description: `Return the final answer (${name}) by calling this tool. Its input is the answer.`,
    parameters: schema,
  };
}

const isFallbackCall = (part: CanonicalPart): boolean =>
  part.type === 'tool_call' && part.name === STRUCTURED_OUTPUT_TOOL;

/** Non-stream response: a call to the fallback tool becomes text content. */
export function unwrapStructuredOutput(res: CanonicalResponse): CanonicalResponse {
  if (!res.content.some(isFallbackCall)) return res;
  const content = res.content.map((part): CanonicalPart =>
    part.type === 'tool_call' && part.name === STRUCTURED_OUTPUT_TOOL
      ? { type: 'text', text: part.arguments }
      : part,
  );
  const otherCalls = content.some((p) => p.type === 'tool_call');
  return {
    ...res,
    content,
    finishReason: res.finishReason === 'tool_calls' && !otherCalls ? 'stop' : res.finishReason,
  };
}

/**
 * Stream counterpart of `unwrapStructuredOutput`: the fallback tool's block is re-emitted as a text
 * block (its argument deltas as text deltas). Keeps only block indexes, not text.
 */
export class StructuredOutputStream {
  readonly #fallback = new Set<number>();
  #otherCalls = false;

  push(event: CanonicalStreamEvent): CanonicalStreamEvent[] {
    switch (event.type) {
      case 'tool_call_start':
        if (event.name === STRUCTURED_OUTPUT_TOOL) {
          this.#fallback.add(event.index);
          return [];
        }
        this.#otherCalls = true;
        return [event];
      case 'tool_call_delta':
        return this.#fallback.has(event.index)
          ? [{ type: 'text_delta', index: event.index, text: event.argumentsDelta }]
          : [event];
      case 'finish':
        return this.#fallback.size > 0 && !this.#otherCalls && event.finishReason === 'tool_calls'
          ? [{ ...event, finishReason: 'stop' }]
          : [event];
      default:
        return [event];
    }
  }
}
