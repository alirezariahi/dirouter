/** Form helpers of the MCP servers page (card 25.3). */
import type { McpControllerCreateBody, McpControllerUpdateBody } from '../api/generated';

export type Transport = 'streamable-http' | 'sse' | 'a2a';
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export interface Draft {
  id?: string;
  name: string;
  slug: string;
  transport: Transport;
  url: string;
  headers: string;
  replaceHeaders: boolean;
  hadHeaders: boolean;
  forwardIdentity: boolean;
  enabled: boolean;
  timeoutMs: string;
}

/** `Name: value` lines to a header object; the number of the first bad line otherwise. */
export function parseHeaders(text: string): Record<string, string> | { badLine: number } {
  const headers: Record<string, string> = {};
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    if (!HEADER_NAME.test(name)) return { badLine: index + 1 };
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** The request body for a draft: headers only when they are new or replaced. */
export function serverBody(
  draft: Draft,
): McpControllerCreateBody | McpControllerUpdateBody | { badLine: number } {
  const parsed = parseHeaders(draft.headers);
  if ('badLine' in parsed && typeof parsed.badLine === 'number') return { badLine: parsed.badLine };
  const headers = parsed as Record<string, string>;
  const hasAny = Object.keys(headers).length > 0;
  const editing = draft.id !== undefined;
  return {
    name: draft.name.trim(),
    slug: draft.slug.trim(),
    transport: draft.transport,
    url: draft.url.trim(),
    forwardIdentity: draft.forwardIdentity,
    enabled: draft.enabled,
    timeoutMs: Number(draft.timeoutMs),
    ...(!editing
      ? hasAny
        ? { headers }
        : {}
      : !draft.hadHeaders || draft.replaceHeaders
        ? { headers: hasAny ? headers : null }
        : {}),
  };
}
