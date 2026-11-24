/**
 * Token estimation when the provider does not return usage (card 6.2), and for filtering by context
 * window in the router. The encoder is loaded once, lazily (o200k_base; for models
 * other than OpenAI it is approximate and the event is marked with `usageEstimated=true`).
 */
import type { CanonicalPart, CanonicalRequest, CanonicalUsage } from '@dirouter/contracts';
import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';

let encoder: Tiktoken | undefined;
const enc = () => (encoder ??= new Tiktoken(o200k));

/** Approximate cost of each image (equivalent to detail=low in OpenAI). */
const IMAGE_TOKENS = 85;
/**
 * Documents and audio (card 27.2) are estimated from their size: about 250 tokens per KB of a PDF
 * (a dense page is ~1.5–3k tokens) and 2 tokens per KB of audio (~32 tokens per second of
 * 128 kbit/s audio). A document or audio given by URL or file id counts as a fixed amount.
 */
const DOCUMENT_TOKENS_PER_KB = 250;
const AUDIO_TOKENS_PER_KB = 2;
const REMOTE_MEDIA_TOKENS = 1_000;

const base64Kb = (data: string) => (data.length * 3) / 4 / 1024;

/** Tokens of an input part that is not text (image, document, audio). */
function mediaTokens(part: CanonicalPart, count: (text: string) => number): number | undefined {
  switch (part.type) {
    case 'image':
      return IMAGE_TOKENS;
    case 'document':
      if (part.source.kind === 'text') return count(part.source.text);
      if (part.source.kind === 'base64')
        return Math.ceil(base64Kb(part.source.data) * DOCUMENT_TOKENS_PER_KB);
      return REMOTE_MEDIA_TOKENS;
    case 'audio':
      return part.source.kind === 'base64'
        ? Math.ceil(base64Kb(part.source.data) * AUDIO_TOKENS_PER_KB)
        : REMOTE_MEDIA_TOKENS;
    default:
      return undefined;
  }
}

/** Overhead per message (role and separators). */
const MESSAGE_OVERHEAD = 4;

export function countTokens(text: string): number {
  if (text === '') return 0;
  return enc().encode(text).length;
}

/** Cheap estimate without a tokenizer (for the hot path): ~4 Latin characters or ~2 non-Latin characters per token. */
export function roughTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (text.length - ascii) / 2);
}

function partText(part: CanonicalPart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'tool_call':
      return `${part.name} ${part.arguments}`;
    case 'tool_result':
      return part.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    case 'reasoning':
      return part.text;
    case 'image':
    case 'document':
    case 'audio':
      return '';
  }
}

/** Estimates output tokens from the response content (text, reasoning, and tool calls). */
export function estimateOutputTokens(
  parts: readonly CanonicalPart[],
  count: (text: string) => number = countTokens,
): number {
  return parts.reduce((n, p) => n + (mediaTokens(p, count) ?? count(partText(p))), 0);
}

/**
 * Estimated usage for when the provider returned nothing; input from the request and output from the content
 * of the response (or the accumulated stream text).
 */
export function estimateUsage(
  req: CanonicalRequest,
  output: readonly CanonicalPart[] | string,
  count: (text: string) => number = countTokens,
): CanonicalUsage {
  return {
    inputTokens: estimateRequestTokens(req, count),
    outputTokens: typeof output === 'string' ? count(output) : estimateOutputTokens(output, count),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

export function estimateRequestTokens(
  req: CanonicalRequest,
  count: (text: string) => number = countTokens,
): number {
  let total = req.system.reduce((n, p) => n + count(p.text), 0);
  for (const message of req.messages) {
    total += MESSAGE_OVERHEAD;
    for (const part of message.content) total += mediaTokens(part, count) ?? count(partText(part));
  }
  for (const tool of req.tools ?? [])
    total += count(`${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.parameters)}`);
  return total;
}
