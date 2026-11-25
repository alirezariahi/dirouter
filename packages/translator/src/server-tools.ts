/**
 * Tools the provider runs itself (card 31.7): web search, code execution and fetching a URL.
 *
 * | canonical        | Anthropic                | OpenAI Chat           | Responses (in)                   | Gemini         |
 * | ---------------- | ------------------------ | --------------------- | -------------------------------- | -------------- |
 * | `web_search`     | `web_search_20250305`    | `web_search_options`  | `web_search`, `web_search_preview` | `googleSearch` |
 * | `code_execution` | `code_execution_20250825` | none: refused        | `code_interpreter`               | `codeExecution` |
 * | `web_fetch`      | `web_fetch_20250910`     | none: refused         | none                             | `urlContext`   |
 *
 * A server tool the destination has no equivalent for is refused with a clear 400
 * (`UnsupportedContentError`), never dropped silently: the answer would otherwise lack what the
 * client asked the provider to do.
 */
import type { CanonicalRequest } from '@dirouter/contracts';

import { UnsupportedContentError } from './common.js';

/** Passthrough key for an Anthropic client's own server tools, kept as sent. */
export const SERVER_TOOLS_KEY = '__anthropic_server_tools';

type ServerTool = NonNullable<CanonicalRequest['serverTools']>[number];
type Json = Record<string, unknown>;

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? v : undefined;
const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

function withOptions(type: ServerTool['type'], raw: Json): ServerTool {
  const maxUses = positive(raw.max_uses);
  const allowed = strings(raw.allowed_domains);
  const blocked = strings(raw.blocked_domains);
  return {
    type,
    ...(maxUses ? { maxUses } : {}),
    ...(allowed ? { allowedDomains: allowed } : {}),
    ...(blocked ? { blockedDomains: blocked } : {}),
  };
}

/** The portable type of an Anthropic server tool, or undefined. */
function anthropicKind(raw: Json): ServerTool['type'] | undefined {
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (type.startsWith('web_search_')) return 'web_search';
  if (type.startsWith('code_execution_')) return 'code_execution';
  if (type.startsWith('web_fetch_')) return 'web_fetch';
  return undefined;
}

/** Anthropic server tools of a request → canonical (the ones with an equivalent). */
export function anthropicServerToolsIn(tools: readonly unknown[]): ServerTool[] {
  return tools.flatMap((tool) => {
    const raw = (tool ?? {}) as Json;
    const kind = anthropicKind(raw);
    return kind ? [withOptions(kind, raw)] : [];
  });
}

/** Canonical server tools → Anthropic's own tool definitions. */
export function anthropicServerToolsOut(tools: CanonicalRequest['serverTools']): Json[] {
  return (tools ?? []).map((tool) => {
    const options = {
      ...(tool.maxUses ? { max_uses: tool.maxUses } : {}),
      ...(tool.allowedDomains ? { allowed_domains: tool.allowedDomains } : {}),
      ...(tool.blockedDomains ? { blocked_domains: tool.blockedDomains } : {}),
    };
    switch (tool.type) {
      case 'web_search':
        return { type: 'web_search_20250305', name: 'web_search', ...options };
      case 'code_execution':
        return { type: 'code_execution_20250825', name: 'code_execution' };
      case 'web_fetch':
        return { type: 'web_fetch_20250910', name: 'web_fetch', ...options };
    }
  });
}

const refuse = (provider: string, what: string) =>
  new UnsupportedContentError(
    'tools[].server',
    `${provider} has no equivalent of the server tool '${what}'; send it to a model that runs it or remove it`,
  );

/**
 * Before a request leaves for a provider that is not Anthropic: an Anthropic-defined tool with no
 * portable equivalent (computer use, a text editor, memory, …) is refused clearly.
 */
export function refuseForeignAnthropicTools(
  request: Pick<CanonicalRequest, 'passthrough' | 'inboundApi'>,
  provider: string,
): void {
  if (request.inboundApi !== 'anthropic.messages') return;
  const tools = request.passthrough?.[SERVER_TOOLS_KEY];
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    const raw = (tool ?? {}) as Json;
    const name =
      typeof raw.type === 'string' ? raw.type : typeof raw.name === 'string' ? raw.name : 'unknown';
    if (!anthropicKind(raw)) throw refuse(provider, name);
  }
}

/** Canonical server tools → OpenAI Chat: web search becomes `web_search_options`. */
export function openAIServerToolsOut(tools: CanonicalRequest['serverTools']): Json | undefined {
  let options: Json | undefined;
  for (const tool of tools ?? []) {
    if (tool.type !== 'web_search') throw refuse('OpenAI Chat', tool.type);
    options = {};
  }
  return options;
}

/** Canonical server tools → Gemini tool entries. */
export function geminiServerToolsOut(tools: CanonicalRequest['serverTools']): Json[] {
  return (tools ?? []).map((tool) =>
    tool.type === 'web_search'
      ? { googleSearch: {} }
      : tool.type === 'code_execution'
        ? { codeExecution: {} }
        : { urlContext: {} },
  );
}

/** A Responses tool that the provider runs → canonical, or undefined. */
export function responsesServerToolIn(tool: Json): ServerTool | undefined {
  if (tool.type === 'web_search' || tool.type === 'web_search_preview') {
    const filters = (tool.filters ?? {}) as Json;
    const allowed = strings(filters.allowed_domains);
    return { type: 'web_search', ...(allowed ? { allowedDomains: allowed } : {}) };
  }
  if (tool.type === 'code_interpreter') return { type: 'code_execution' };
  return undefined;
}

/** A Gemini tool entry that the provider runs → canonical, or undefined. */
export function geminiServerToolIn(group: Json): ServerTool | undefined {
  if (group.googleSearch !== undefined || group.googleSearchRetrieval !== undefined)
    return { type: 'web_search' };
  if (group.codeExecution !== undefined) return { type: 'code_execution' };
  if (group.urlContext !== undefined) return { type: 'web_fetch' };
  return undefined;
}

/** Refuses every server tool, for providers that run none (Bedrock Converse). */
export function refuseServerTools(
  request: Pick<CanonicalRequest, 'serverTools'>,
  provider: string,
): void {
  const first = request.serverTools?.[0];
  if (first) throw refuse(provider, first.type);
}
