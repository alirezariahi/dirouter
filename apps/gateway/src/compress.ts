/**
 * Context compression (card 13.3): shrinks long agent conversations without changing their shape.
 *
 * What it does to messages older than the last `keepRecentMessages`:
 *  - cleans tool output (ANSI escapes, trailing spaces, blank-line runs, repeated lines, noisy
 *    `git diff` headers);
 *  - replaces a tool result that repeats an earlier one byte-for-byte with a short reference;
 *  - truncates very long tool results to a character budget, keeping the head and the tail
 *    (errors and summaries usually sit at the end);
 *  - drops old reasoning blocks, which cannot be replayed reliably across providers.
 *
 * What it never does: remove a message, remove or reorder a tool_call or tool_result part, or touch
 * their ids. Providers reject a conversation whose tool calls and results do not pair up, so the
 * structure is left exactly as the client sent it and `verifyStructure` re-checks that before the
 * result is used; on any mismatch the original request is returned untouched.
 *
 * It is a pure function over the canonical request and never touches the client's payload.
 */
import type {
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CompressionSettings,
} from '@dirouter/contracts';

export interface CompressionResult {
  request: CanonicalRequest;
  /** Always 0: messages are never removed (kept for log compatibility). */
  removedMessages: number;
  /** Tool results replaced by a reference to an identical earlier result. */
  dedupedParts: number;
  truncatedParts: number;
  droppedReasoningParts: number;
  savedChars: number;
}

/** Results shorter than this are not worth replacing with a reference. */
const MIN_DEDUPE_CHARS = 200;
const HEAD_SHARE = 0.6;
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/** Lossless-in-meaning cleanup of command output. */
export function cleanToolOutput(text: string): string {
  if (text.length < 80) return text;
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  const isDiff = lines.some((line) => line.startsWith('diff --git '));
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    // Object hashes and file modes of a diff carry nothing the model can use.
    if (
      isDiff &&
      (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(line) ||
        /^(old|new|deleted file|new file) mode \d+$/.test(line) ||
        /^similarity index \d+%$/.test(line))
    ) {
      index += 1;
      continue;
    }
    let run = 1;
    while (index + run < lines.length && lines[index + run] === line) run += 1;
    if (line === '') {
      // A run of blank lines becomes one.
      out.push('');
    } else if (run <= 3) {
      for (let n = 0; n < run; n++) out.push(line);
    } else {
      out.push(line, `… [previous line repeated ${String(run - 1)} more times]`);
    }
    index += run;
  }
  const cleaned = out.join('\n');
  return cleaned.length < text.length ? cleaned : text;
}

/** Keeps the start and the end of a long text; the middle is replaced by a marker. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * HEAD_SHARE));
  const tail = Math.max(0, maxChars - head);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${String(omitted)} characters omitted]…\n${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

function resultText(part: Extract<CanonicalPart, { type: 'tool_result' }>): string | undefined {
  // Results with images are left alone: there is no cheap way to compare or shorten them.
  if (part.content.some((c) => c.type !== 'text')) return undefined;
  return part.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

/** Tool-call structure of a conversation; compression must leave it byte-identical. */
export function structureOf(messages: readonly CanonicalMessage[]): string {
  return messages
    .map(
      (message) =>
        `${message.role}:${message.content
          .filter((part) => part.type === 'tool_call' || part.type === 'tool_result')
          .map((part) =>
            part.type === 'tool_call'
              ? `call(${part.id},${part.name},${part.arguments})`
              : `result(${part.toolCallId})`,
          )
          .join(',')}`,
    )
    .join('|');
}

/** True when both conversations have the same messages, roles and tool call/result pairing. */
export function verifyStructure(
  before: readonly CanonicalMessage[],
  after: readonly CanonicalMessage[],
): boolean {
  return (
    before.length === after.length &&
    after.every((message) => message.content.length > 0) &&
    structureOf(before) === structureOf(after)
  );
}

const unchanged = (request: CanonicalRequest): CompressionResult => ({
  request,
  removedMessages: 0,
  dedupedParts: 0,
  truncatedParts: 0,
  droppedReasoningParts: 0,
  savedChars: 0,
});

export function compressRequest(
  request: CanonicalRequest,
  settings: CompressionSettings,
): CompressionResult {
  if (!settings.enabled) return unchanged(request);
  const boundary = Math.max(0, request.messages.length - Math.max(0, settings.keepRecentMessages));
  /** Full text of an earlier tool result → the call id it belonged to. */
  const seen = new Map<string, string>();
  let dedupedParts = 0;
  let truncatedParts = 0;
  let droppedReasoningParts = 0;
  let savedChars = 0;

  const messages = request.messages.map((message, index) => {
    if (index >= boundary) {
      // Recent results are sent as-is but still remembered, so nothing later is compared wrongly.
      return message;
    }
    let content: CanonicalPart[] = message.content;
    if (settings.dropOldReasoning) {
      const kept = content.filter((part) => part.type !== 'reasoning');
      // Never leave a message empty: an empty assistant turn is rejected upstream.
      if (kept.length > 0 && kept.length < content.length) {
        for (const part of content)
          if (part.type === 'reasoning') {
            droppedReasoningParts += 1;
            savedChars += part.text.length;
          }
        content = kept;
      }
    }
    content = content.map((part) => {
      if (part.type !== 'tool_result') return part;
      const original = resultText(part);
      if (original === undefined) return part;
      const replace = (text: string): CanonicalPart => ({
        ...part,
        content: [{ type: 'text', text }],
      });
      if (settings.dedupe && original.length >= MIN_DEDUPE_CHARS) {
        const earlier = seen.get(original);
        if (earlier !== undefined && earlier !== part.toolCallId) {
          const stub = `[same output as the earlier tool call ${earlier}]`;
          dedupedParts += 1;
          savedChars += original.length - stub.length;
          return replace(stub);
        }
        seen.set(original, part.toolCallId);
      }
      const cleaned = cleanToolOutput(original);
      const shortened = truncateMiddle(cleaned, settings.maxToolResultChars);
      if (shortened.length >= original.length) return part;
      if (cleaned.length > settings.maxToolResultChars) truncatedParts += 1;
      savedChars += original.length - shortened.length;
      return replace(shortened);
    });
    return content === message.content ? message : { ...message, content };
  });

  if (savedChars <= 0) return unchanged(request);
  // Fail-safe: if anything about the tool-call structure changed, send the original.
  if (!verifyStructure(request.messages, messages)) return unchanged(request);
  return {
    request: { ...request, messages },
    removedMessages: 0,
    dedupedParts,
    truncatedParts,
    droppedReasoningParts,
    savedChars,
  };
}
