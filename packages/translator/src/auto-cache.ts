/**
 * Automatic prompt-cache breakpoints (card 31.3).
 *
 * Providers with explicit prompt caching (Anthropic, Bedrock) only cache what a breakpoint marks.
 * Clients that send no `cache_control` (every OpenAI-format client, most SDK code) never benefit.
 * For a model or alias with `autoCache`, the gateway marks the stable prefix of such a request:
 *
 * - the last tool definition (the whole tool list is cached);
 * - the last system block;
 * - the last cacheable block of the last message (the next turn reads everything up to it);
 * - the last cacheable block of the turn before the last answer (where the previous request
 *   ended), so the cache is still found when the newest turn adds more blocks than the provider
 *   looks back over.
 *
 * At most four breakpoints, which is Anthropic's and Bedrock's limit. A request that carries any
 * breakpoint of its own (a marker on a block, or Anthropic's top-level `cache_control`) is left
 * exactly as it is.
 */
import type { CanonicalMessage, CanonicalPart, CanonicalRequest } from '@dirouter/contracts';

/** Where a breakpoint was placed, for logs. */
export type CacheBreakpoint = 'tools' | 'system' | 'last_message' | 'previous_turn';

const MAX_BREAKPOINTS = 4;

type Cacheable = Exclude<CanonicalPart, { type: 'reasoning' } | { type: 'audio' }>;

const cacheable = (part: CanonicalPart): part is Cacheable =>
  part.type !== 'reasoning' && part.type !== 'audio';

/** The request already sets its own breakpoints. */
export function hasCacheMarkers(request: CanonicalRequest): boolean {
  if (request.inboundApi === 'anthropic.messages' && request.passthrough?.cache_control)
    return true;
  if (request.system.some((p) => p.cache)) return true;
  if (request.tools?.some((t) => t.cache)) return true;
  return request.messages.some((m) =>
    m.content.some(
      (p) =>
        (cacheable(p) && p.cache === true) ||
        (p.type === 'tool_result' && p.content.some((c) => c.cache === true)),
    ),
  );
}

/** Index of the message's last block that can carry a breakpoint, or -1. */
function lastCacheable(message: CanonicalMessage): number {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i];
    if (part && cacheable(part)) return i;
  }
  return -1;
}

function markMessage(
  message: CanonicalMessage,
  ttl: string | undefined,
): CanonicalMessage | undefined {
  const at = lastCacheable(message);
  if (at === -1) return undefined;
  const content = message.content.map((part, i) =>
    i === at && cacheable(part)
      ? { ...part, cache: true, ...(ttl ? { cacheTtl: ttl } : {}) }
      : part,
  );
  return { ...message, content };
}

/**
 * The request with breakpoints on its stable prefix, or the same object when it already has
 * breakpoints or has nothing to mark. `ttl` (`5m`, `1h`) is optional; unset means the provider
 * default.
 */
export function injectCacheBreakpoints(
  request: CanonicalRequest,
  ttl?: string,
): { request: CanonicalRequest; breakpoints: CacheBreakpoint[] } {
  if (hasCacheMarkers(request)) return { request, breakpoints: [] };
  const breakpoints: CacheBreakpoint[] = [];
  const marker = { cache: true, ...(ttl ? { cacheTtl: ttl } : {}) };
  let next: CanonicalRequest = request;

  const tools = request.tools;
  if (tools?.length) {
    next = {
      ...next,
      tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, ...marker } : t)),
    };
    breakpoints.push('tools');
  }
  if (request.system.length > 0) {
    const last = request.system.length - 1;
    next = {
      ...next,
      system: request.system.map((p, i) => (i === last ? { ...p, ...marker } : p)),
    };
    breakpoints.push('system');
  }

  const messages = [...request.messages];
  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex];
  const marked = lastMessage ? markMessage(lastMessage, ttl) : undefined;
  if (marked) {
    messages[lastIndex] = marked;
    breakpoints.push('last_message');
  }
  // Where the previous request ended: the turn right before the last assistant answer.
  let previousUser = -1;
  for (let i = lastIndex - 1; i > 0; i--) {
    if (messages[i]?.role !== 'assistant') continue;
    if (messages[i - 1]?.role !== 'assistant') previousUser = i - 1;
    break;
  }
  const previous = previousUser >= 0 ? messages[previousUser] : undefined;
  if (previous && breakpoints.length < MAX_BREAKPOINTS) {
    const markedPrevious = markMessage(previous, ttl);
    if (markedPrevious) {
      messages[previousUser] = markedPrevious;
      breakpoints.push('previous_turn');
    }
  }
  if (breakpoints.includes('last_message') || breakpoints.includes('previous_turn'))
    next = { ...next, messages };
  return breakpoints.length ? { request: next, breakpoints } : { request, breakpoints };
}
